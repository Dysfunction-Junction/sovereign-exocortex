import { startMishmash, stopMishmash } from "./mishmash-launch.js";

const handle = await startMishmash();
console.log("mishmash is up on this PC");
for (const [id, upstream] of Object.entries(handle.upstreams)) {
  console.log(`  ${id}  ${upstream}`);
}

const shutdown = async () => {
  await stopMishmash(handle);
  process.exit(0);
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
