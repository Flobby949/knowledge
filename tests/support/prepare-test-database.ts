import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDirectory = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

export interface PreparedTestDatabase {
  databaseUrl: string;
  dispose: () => void;
}

export function prepareTestDatabase(options?: {
  migrationsThrough?: string;
}): PreparedTestDatabase {
  const databaseName = `knowledge_test_${randomUUID().replaceAll("-", "")}`;
  const postgresUser = readPostgresEnvironment("POSTGRES_USER");
  const postgresPassword = readPostgresEnvironment("POSTGRES_PASSWORD");

  runDockerCompose([
    "exec",
    "-T",
    "postgres",
    "createdb",
    "--username",
    postgresUser,
    "--maintenance-db",
    "postgres",
    databaseName,
  ]);

  try {
    for (const filename of readdirSync(migrationsDirectory)
      .filter((entry) => entry.endsWith(".sql"))
      .filter(
        (entry) =>
          options?.migrationsThrough === undefined ||
          entry <= options.migrationsThrough,
      )
      .sort()) {
      runDockerCompose(
        [
          "exec",
          "-T",
          "postgres",
          "psql",
          "--username",
          postgresUser,
          "--dbname",
          databaseName,
          "--no-psqlrc",
          "--set",
          "ON_ERROR_STOP=1",
        ],
        readFileSync(`${migrationsDirectory}/${filename}`, "utf8"),
      );
    }
  } catch (error) {
    dropDatabase(postgresUser, databaseName);
    throw error;
  }

  const port = publishedPostgresPort();
  const databaseUrl =
    `postgresql://${encodeURIComponent(postgresUser)}` +
    `:${encodeURIComponent(postgresPassword)}` +
    `@127.0.0.1:${port}/${databaseName}`;
  let disposed = false;

  return {
    databaseUrl,
    dispose() {
      if (disposed) {
        return;
      }

      dropDatabase(postgresUser, databaseName);
      disposed = true;
    },
  };
}

function readPostgresEnvironment(name: string): string {
  return runDockerCompose(["exec", "-T", "postgres", "printenv", name]).trim();
}

function publishedPostgresPort(): string {
  const address = runDockerCompose(["port", "postgres", "5432"])
    .trim()
    .split("\n", 1)[0];
  const port = address?.match(/:(\d+)$/)?.[1];

  if (!port) {
    throw new Error(`Could not determine the PostgreSQL port from: ${address}`);
  }

  return port;
}

function dropDatabase(postgresUser: string, databaseName: string): void {
  runDockerCompose([
    "exec",
    "-T",
    "postgres",
    "dropdb",
    "--if-exists",
    "--force",
    "--username",
    postgresUser,
    "--maintenance-db",
    "postgres",
    databaseName,
  ]);
}

function runDockerCompose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}
