// PC-only: grant a scope (including admin) to an enrolled device. /v3/devices/enroll never grants admin.
import { getDatabase } from "./db-host.js";

const KNOWN = ["telemetry:write", "approval:write", "admin:read", "admin:write", "admin"];
const [deviceId, scope] = process.argv.slice(2);
if (!deviceId || !scope || !KNOWN.includes(scope)) {
  console.error(`Usage: tsx src/grant-scope-cli.ts <deviceId> <${KNOWN.join("|")}>`);
  process.exit(1);
}
if (!getDatabase().grantDeviceScope(deviceId, scope)) {
  console.error(`Device not found or revoked: ${deviceId}`);
  process.exit(1);
}
console.log(`Granted ${scope} to ${deviceId}`);
