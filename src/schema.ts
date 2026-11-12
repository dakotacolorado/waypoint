import { createRoute, z } from "@hono/zod-openapi";
import { MAX_CRITERIA, MAX_LABELS, MAX_SUBTASKS, STATUSES } from "./domain.ts";

/** Validates every request and generates `openapi.json`, so neither can drift. */

// --- shared ----------------------------------------------------------------

const TaskRef = z.string().min(8).describe("The task's ID, or a prefix of it at least 8 characters long, such as its `shortId`.");
const Timestamp = z.string().describe("When, as an ISO 8601 date and time in UTC.");
const Actor = z
  .string()
  .nullable()
  .describe("Who made the write: its `x-actor` header, else the name of its token. Null for an admin token that named no one.");
const ClientToken = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("A unique string you choose. Retrying a request with the same token returns what the first created, instead of creating another.");

export const Status = z.enum(STATUSES).describe("Where it stands. `done` and `cancelled` are the closed statuses.");

const MaxResults = z.coerce.number().int().min(1).max(500).optional().describe("The most results to return. Default 100.");
const NextToken = z.string().optional().describe("The `nextToken` from the previous page.");
const Page = { nextToken: z.string().nullable().describe("The token for the next page, or null on the last.") };

export const ErrorSchema = z
  .object({
    code: z
      .enum(["ValidationException", "UnauthorizedException", "ResourceNotFoundException", "ConflictException", "InternalServerException"])
      .describe("What kind of error it is."),
    message: z.string().describe("What went wrong."),
    blockedBy: z.array(z.string()).optional().describe("The open tasks, or subtasks, it waits on."),
    unmetCriteria: z.array(z.string()).optional().describe("The criteria not yet met."),
    openSubtasks: z.array(z.string()).optional().describe("The IDs of the subtasks not yet closed."),
    matches: z.array(z.string()).optional().describe("The task IDs a short ID matches."),
  })
  .openapi("Error");

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });

const UNAUTHORIZED = "The `Authorization` header is missing, or its token isn't one this service issued.";

/** An operation's errors, each with what causes it there; every secured operation can also answer UnauthorizedException. */
const errors = (causes: { 400?: string; 404?: string; 409?: string }) => {
  const entry = (code: string, cause: string) => json(ErrorSchema, `${code}: ${cause}`);
  return {
    ...(causes[400] && { 400: entry("ValidationException", causes[400]) }),
    401: entry("UnauthorizedException", UNAUTHORIZED),
    ...(causes[404] && { 404: entry("ResourceNotFoundException", causes[404]) }),
    ...(causes[409] && { 409: entry("ConflictException", causes[409]) }),
  };
};

const NO_TASK = "No task has that ID.";
const AMBIGUOUS = "The short ID matches more than one task; `matches` lists them.";
const INVALID = "A field is missing, malformed or out of bounds; `message` says which.";

const ActorHeader = z.object({
  "x-actor": z.string().max(200).optional().describe("Who is making the write, recorded in history in place of the token's name. For a token several callers share."),
});

const secured = { security: [{ bearerAuth: [] }] };

// --- tasks -----------------------------------------------------------------

export const CriterionSchema = z
  .object({
    id: z.string().describe("The criterion's ID within its task: `c1`, `c2`, and so on. Kept for as long as the criterion is."),
    text: z.string().describe("What must be true."),
    met: z.boolean().describe("Whether it has been marked met."),
    metBy: Actor.describe("Who marked it met; null while it isn't."),
    metAt: Timestamp.nullable().describe("When it was marked met; null while it isn't."),
  })
  .openapi("Criterion");

export const SubtaskSchema = z
  .object({
    id: z.string().describe("The subtask's ID within its task: `s1`, `s2`, and so on. Kept for as long as the subtask is."),
    title: z.string().describe("A short name for the step."),
    description: z.string().describe("What the step is, in Markdown."),
    status: Status,
    dependsOn: z.array(z.string()).describe("The IDs of the subtasks of the same task this one waits on."),
    blockedBy: z.array(z.string()).describe("The subtasks in `dependsOn` that aren't closed yet."),
  })
  .openapi("Subtask");

export const TaskSchema = z
  .object({
    id: z.string().describe("The task's ID, a UUID."),
    shortId: z.string().describe("The shortest prefix of `id`, at least 8 characters, that no other task's ID starts with. Accepted wherever an ID is."),
    title: z.string().describe("A short name for the task."),
    description: z.string().describe("What the task is, in Markdown."),
    status: Status,
    dependsOn: z.array(z.string()).describe("The IDs of the tasks this one waits on."),
    subtasks: z.array(SubtaskSchema).describe("The steps of the work, in order. The task can't be `done` until each is closed."),
    criteria: z.array(CriterionSchema).describe("The acceptance criteria, in order. The task can't be `done` until each is met."),
    labels: z.array(z.string()).describe("The IDs of its labels."),
    assignee: z.string().nullable().describe("Who the task is assigned to, as free text; null if no one."),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    blockedBy: z.array(z.string()).describe("The tasks in `dependsOn` that aren't closed yet."),
    ready: z.boolean().describe("Whether it can be started now: in `backlog`, with nothing in `blockedBy`."),
  })
  .openapi("Task");

const TaskResponse = z.object({ task: TaskSchema }).openapi("TaskResponse");

const CriterionInput = z
  .object({
    id: z.string().optional().describe("The ID of an existing criterion. Omit it for a new one."),
    text: z.string().trim().min(1).max(500).optional().describe("What must be true. Required for a new criterion."),
    met: z.boolean().optional().describe("Whether it is met. Omit it to leave it as it stands when the write lands."),
  })
  .openapi("CriterionInput");

const SubtaskInput = z
  .object({
    id: z.string().optional().describe("The ID of an existing subtask. Omit it for a new one."),
    title: z.string().trim().min(1).max(200).optional().describe("A short name for the step. Required for a new subtask."),
    description: z.string().max(20_000).optional().describe("What the step is, in Markdown."),
    status: Status.optional().describe("Where the step stands. Omit it to leave it as it stands when the write lands; a new subtask starts in `backlog`."),
    dependsOn: z.array(z.string()).max(50).optional().describe("The IDs of subtasks of the same task this one waits on."),
  })
  .openapi("SubtaskInput");

const TaskFields = {
  title: z.string().trim().min(1).max(200).describe("A short name for the task."),
  description: z.string().max(20_000).describe("What the task is, in Markdown."),
  status: Status,
  dependsOn: z.array(z.string()).max(50).describe("The IDs of the tasks this one waits on."),
  subtasks: z
    .array(SubtaskInput)
    .max(MAX_SUBTASKS)
    .describe("The steps of the work, in order. On update this is the whole list: a subtask left out is removed."),
  criteria: z
    .array(CriterionInput)
    .max(MAX_CRITERIA)
    .describe("The acceptance criteria, in order. On update this is the whole list: a criterion left out is removed."),
  labels: z.array(z.string()).max(MAX_LABELS).describe("Labels, each by ID or name."),
  assignee: z.string().trim().min(1).max(200).nullable().describe("Who the task is assigned to; null for no one."),
};

export const CreateTaskInput = z
  .object({ ...TaskFields, clientToken: ClientToken })
  .partial()
  .required({ title: true })
  .openapi("CreateTaskInput");

/** Every field a task's create or update may give, each optional: the MCP tools' input. */
export const TaskFieldsInput = z.object(TaskFields).partial();

export const UpdateTaskInput = z
  .object(TaskFields)
  .partial()
  .refine((input) => Object.keys(input).length > 0, { message: "no fields given" })
  .openapi("UpdateTaskInput");

const TaskParam = z.object({ taskId: TaskRef.openapi({ param: { name: "taskId", in: "path" } }) });

export const listTasks = createRoute({
  ...secured,
  method: "get",
  path: "/tasks",
  operationId: "ListTasks",
  tags: ["Tasks"],
  summary: "List tasks",
  description: "Returns tasks matching every filter given, oldest first. Cancelled tasks are left out unless `status` is `cancelled` or `includeCancelled` is `true`.",
  request: {
    query: z.object({
      status: Status.optional().describe("Only tasks with this status."),
      ready: z.enum(["true", "false"]).optional().describe("`true` for only tasks that can be started now; `false` for only those that can't."),
      label: z.string().optional().describe("Only tasks with this label, by ID or name."),
      assignee: z.string().optional().describe("Only tasks assigned to this; `none` for only unassigned tasks."),
      includeCancelled: z.enum(["true", "false"]).optional().describe("`true` to include cancelled tasks."),
      maxResults: MaxResults,
      nextToken: NextToken,
    }),
  },
  responses: {
    200: json(z.object({ tasks: z.array(TaskSchema).describe("The tasks."), ...Page }).openapi("ListTasksResponse"), "Success."),
    ...errors({ 400: INVALID }),
  },
});

export const createTask = createRoute({
  ...secured,
  method: "post",
  path: "/tasks",
  operationId: "CreateTask",
  tags: ["Tasks"],
  summary: "Create a task",
  description: "Creates a task in `backlog`, unless `status` says otherwise. A status past `backlog` is held to the same rules as `UpdateTask`.",
  request: { headers: ActorHeader, body: json(CreateTaskInput, "The task.") },
  responses: {
    201: json(TaskResponse, "Created."),
    ...errors({
      400: `${INVALID} Also: a dependency cycle, among tasks or among its subtasks.`,
      404: "A task or label named in the body doesn't exist.",
      409: "The status given is refused: see `UpdateTask`.",
    }),
  },
});

export const getTask = createRoute({
  ...secured,
  method: "get",
  path: "/tasks/{taskId}",
  operationId: "GetTask",
  tags: ["Tasks"],
  summary: "Get a task",
  request: { params: TaskParam },
  responses: { 200: json(TaskResponse, "Success."), ...errors({ 404: NO_TASK, 409: AMBIGUOUS }) },
});

export const updateTask = createRoute({
  ...secured,
  method: "patch",
  path: "/tasks/{taskId}",
  operationId: "UpdateTask",
  tags: ["Tasks"],
  summary: "Update a task",
  description:
    "Changes the fields given. In `criteria` and `subtasks`, a field left out of an entry keeps its value as it stands when the write lands: to mark one criterion met, send `met: true` on that entry only. Cancelling a task cancels its open subtasks.",
  request: { params: TaskParam, headers: ActorHeader, body: json(UpdateTaskInput, "The fields to change.") },
  responses: {
    200: json(TaskResponse, "Success."),
    ...errors({
      400: `${INVALID} Also: a dependency cycle, among tasks or among its subtasks, or a criterion or subtask ID the task doesn't have.`,
      404: "No task has that ID, or a task or label named in the body doesn't exist.",
      409: `Moving the task, or a subtask, to \`in_progress\`, \`review\` or \`done\` while its \`blockedBy\` isn't empty; moving the task to \`done\` while a criterion is unmet (\`unmetCriteria\`) or a subtask is open (\`openSubtasks\`). Or: ${AMBIGUOUS}`,
    }),
  },
});

export const deleteTask = createRoute({
  ...secured,
  method: "delete",
  path: "/tasks/{taskId}",
  operationId: "DeleteTask",
  tags: ["Tasks"],
  summary: "Delete a task",
  description: "Deletes a task no other task depends on. To close a task instead, set its status to `cancelled`.",
  request: { params: TaskParam, headers: ActorHeader },
  responses: {
    204: { description: "Deleted." },
    ...errors({ 404: NO_TASK, 409: `Another task depends on it. Or: ${AMBIGUOUS}` }),
  },
});

export const HistoryEntrySchema = z
  .object({
    taskId: z.string().describe("The task written."),
    action: z.enum(["created", "updated", "deleted"]).describe("What the write did."),
    changes: z
      .array(
        z.object({
          field: z.string().describe("The field that changed."),
          from: z.unknown().describe("Its value before; null on `created`."),
          to: z.unknown().describe("Its value after; null on `deleted`."),
        }),
      )
      .describe("Each field the write changed."),
    actor: Actor,
    at: Timestamp,
  })
  .openapi("HistoryEntry");

export const listTaskHistory = createRoute({
  ...secured,
  method: "get",
  path: "/tasks/{taskId}/history",
  operationId: "ListTaskHistory",
  tags: ["Tasks"],
  summary: "List a task's history",
  description: "Returns every write to the task, oldest first.",
  request: { params: TaskParam, query: z.object({ maxResults: MaxResults, nextToken: NextToken }) },
  responses: {
    200: json(z.object({ entries: z.array(HistoryEntrySchema).describe("The writes."), ...Page }).openapi("ListTaskHistoryResponse"), "Success."),
    ...errors({ 400: INVALID, 404: NO_TASK, 409: AMBIGUOUS }),
  },
});

// --- comments --------------------------------------------------------------

export const CommentSchema = z
  .object({
    id: z.string().describe("The comment's ID."),
    taskId: z.string().describe("The task it is on."),
    author: Actor.describe("Who wrote it: its `x-actor` header, else the name of its token."),
    body: z.string().describe("The comment, in Markdown."),
    createdAt: Timestamp,
  })
  .openapi("Comment");

export const listComments = createRoute({
  ...secured,
  method: "get",
  path: "/tasks/{taskId}/comments",
  operationId: "ListComments",
  tags: ["Comments"],
  summary: "List comments",
  description: "Returns a task's comments, oldest first.",
  request: { params: TaskParam, query: z.object({ maxResults: MaxResults, nextToken: NextToken }) },
  responses: {
    200: json(z.object({ comments: z.array(CommentSchema).describe("The comments."), ...Page }).openapi("ListCommentsResponse"), "Success."),
    ...errors({ 400: INVALID, 404: NO_TASK, 409: AMBIGUOUS }),
  },
});

export const createComment = createRoute({
  ...secured,
  method: "post",
  path: "/tasks/{taskId}/comments",
  operationId: "CreateComment",
  tags: ["Comments"],
  summary: "Create a comment",
  description: "Adds a comment to a task. A comment changes none of the task's fields.",
  request: {
    params: TaskParam,
    headers: ActorHeader,
    body: json(
      z.object({ body: z.string().trim().min(1).max(20_000).describe("The comment, in Markdown."), clientToken: ClientToken }).openapi("CreateCommentInput"),
      "The comment.",
    ),
  },
  responses: {
    201: json(z.object({ comment: CommentSchema }).openapi("CommentResponse"), "Created."),
    ...errors({ 400: INVALID, 404: NO_TASK, 409: AMBIGUOUS }),
  },
});

// --- labels ----------------------------------------------------------------

export const LabelSchema = z
  .object({
    id: z.string().describe("The label's ID."),
    name: z.string().describe("The label's name, unique ignoring case."),
    color: z.string().describe("Its colour, as `#rrggbb`."),
    description: z.string().describe("What the label is for."),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi("Label");

const LabelResponse = z.object({ label: LabelSchema }).openapi("LabelResponse");

const LabelFields = {
  name: z.string().trim().min(1).max(40).describe("The label's name, unique ignoring case."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb").describe("Its colour, as `#rrggbb`. Default `#808080`."),
  description: z.string().trim().max(500).describe("What the label is for."),
};

export const CreateLabelInput = z
  .object({ ...LabelFields, clientToken: ClientToken })
  .partial()
  .required({ name: true })
  .openapi("CreateLabelInput");

export const LabelFieldsInput = z.object(LabelFields).partial();

export const UpdateLabelInput = z
  .object(LabelFields)
  .partial()
  .refine((input) => Object.keys(input).length > 0, { message: "no fields given" })
  .openapi("UpdateLabelInput");

const LabelParam = z.object({ labelId: z.string().describe("The label's ID or name.").openapi({ param: { name: "labelId", in: "path" } }) });

const NO_LABEL = "No label has that ID or name.";
const NAME_TAKEN = "Another label has that name.";

export const listLabels = createRoute({
  ...secured,
  method: "get",
  path: "/labels",
  operationId: "ListLabels",
  tags: ["Labels"],
  summary: "List labels",
  description: "Returns labels by name.",
  request: { query: z.object({ maxResults: MaxResults, nextToken: NextToken }) },
  responses: {
    200: json(z.object({ labels: z.array(LabelSchema).describe("The labels."), ...Page }).openapi("ListLabelsResponse"), "Success."),
    ...errors({ 400: INVALID }),
  },
});

export const createLabel = createRoute({
  ...secured,
  method: "post",
  path: "/labels",
  operationId: "CreateLabel",
  tags: ["Labels"],
  summary: "Create a label",
  request: { body: json(CreateLabelInput, "The label.") },
  responses: { 201: json(LabelResponse, "Created."), ...errors({ 400: INVALID, 409: NAME_TAKEN }) },
});

export const getLabel = createRoute({
  ...secured,
  method: "get",
  path: "/labels/{labelId}",
  operationId: "GetLabel",
  tags: ["Labels"],
  summary: "Get a label",
  request: { params: LabelParam },
  responses: { 200: json(LabelResponse, "Success."), ...errors({ 404: NO_LABEL }) },
});

export const updateLabel = createRoute({
  ...secured,
  method: "patch",
  path: "/labels/{labelId}",
  operationId: "UpdateLabel",
  tags: ["Labels"],
  summary: "Update a label",
  description: "Changes the fields given.",
  request: { params: LabelParam, body: json(UpdateLabelInput, "The fields to change.") },
  responses: { 200: json(LabelResponse, "Success."), ...errors({ 400: INVALID, 404: NO_LABEL, 409: NAME_TAKEN }) },
});

export const deleteLabel = createRoute({
  ...secured,
  method: "delete",
  path: "/labels/{labelId}",
  operationId: "DeleteLabel",
  tags: ["Labels"],
  summary: "Delete a label",
  description: "Deletes a label and removes it from every task that has it.",
  request: { params: LabelParam },
  responses: { 204: { description: "Deleted." }, ...errors({ 404: NO_LABEL }) },
});

// --- service ---------------------------------------------------------------

export const getHealth = createRoute({
  method: "get",
  path: "/health",
  operationId: "GetHealth",
  tags: ["Service"],
  summary: "Get health",
  description: "Reports that the service is up, and which build it runs. Needs no token.",
  responses: {
    200: json(
      z
        .object({
          ok: z.literal(true).describe("Always true: an answer means the service is up."),
          version: z.string().describe("The package version."),
          commit: z.string().describe("The git commit it was built from."),
        })
        .openapi("Health"),
      "Success.",
    ),
  },
});

export const ROUTES = [
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  listTaskHistory,
  listComments,
  createComment,
  listLabels,
  createLabel,
  getLabel,
  updateLabel,
  deleteLabel,
  getHealth,
];
