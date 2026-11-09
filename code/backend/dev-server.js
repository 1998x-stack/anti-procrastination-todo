/**
 * Local-only integration probe. Disabled unless intentionally opted in.
 * NEVER deploy this in-memory adapter as a public production service.
 */
import { createTelemetryServer } from "./server.js";

if (process.env.START_FIRST_LOCAL_TELEMETRY !== "1" || process.env.NODE_ENV === "production") {
  process.stderr.write("Local research reference server disabled. Set START_FIRST_LOCAL_TELEMETRY=1 for loopback testing only.\n");
  process.exitCode = 1;
} else {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("INVALID_PORT");
  }
  const server = createTelemetryServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("Local-only telemetry reference listening on 127.0.0.1:" + port + "\n");
  });
}
