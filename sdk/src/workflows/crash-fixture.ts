import { WorkflowOwner, activity } from "./index.js";

const owner = new WorkflowOwner({ id: "owner", path: process.argv[2], definitions: [{ type: "echo", version: "1", *run(input) { return yield activity("echo@1", input); } }] });
owner.start({ id: "crash-job", type: "echo", version: "1", input: "survived" });
process.stdout.write("committed\n");
setInterval(() => {}, 60_000);
