// PC-only: surface one harmless test proposal so the phone has something to approve.
import { getDatabase } from "./db-host.js";
import { surfaceTestProposal } from "./dev-tools.js";

const id = surfaceTestProposal(getDatabase());
console.log(`Surfaced test proposal ${id} (valid for 10 minutes).`);
console.log("Open the app: it appears within ~10 seconds while the app is in the foreground.");
