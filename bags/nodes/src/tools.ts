import { Barry } from "@barry-rocks/sdk";

import { readNodeStore } from "./store.js";
export const tools = [
    Barry.Tool({ namespace: "nodes", name: "list", description: "This installation's id, the workers it invited, and the owners it works for", access: "read", schema: {}, handler: async () => {
        return readNodeStore();
    } }),
];
