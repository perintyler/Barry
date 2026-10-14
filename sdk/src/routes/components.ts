import { servicesComponents } from "./services.js";
import { ProblemDetailsSchema } from "../errors.js";
import { sessionsComponents } from "./sessions.js";
import { identitiesComponents } from "./identities.js";
import { changesComponents } from "./changes.js";
import { eventsComponents } from "./events.js";
import { actionsComponents } from "./actions.js";
import { jobsComponents } from "./jobs.js";
import { aguiComponents } from "./ag-ui.js";
import { devicesComponents } from "./devices.js";
import { schedulesComponents } from "./schedules.js";

export const components = { ...servicesComponents, ProblemDetails: ProblemDetailsSchema, ...sessionsComponents, ...identitiesComponents, ...changesComponents, ...eventsComponents, ...actionsComponents, ...jobsComponents, ...aguiComponents, ...devicesComponents, ...schedulesComponents };
