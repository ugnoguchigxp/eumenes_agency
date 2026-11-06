import { runMockConversation } from "./mock-scenario.ts";
console.log(JSON.stringify(await runMockConversation(), null, 2));
