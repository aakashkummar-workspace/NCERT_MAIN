// Waits for the Docker Postgres to accept connections. Polls a condition
// rather than sleeping a guessed number of seconds.
import { execSync } from "node:child_process";

const DEADLINE = Date.now() + 60_000;

while (Date.now() < DEADLINE) {
  try {
    execSync("docker exec sahayak-pg pg_isready -U postgres -d sahayak", {
      stdio: "ignore",
    });
    console.log("Postgres is ready on localhost:5434");
    process.exit(0);
  } catch {
    // not up yet
  }
}

console.error("Postgres did not become ready within 60s.");
process.exit(1);
