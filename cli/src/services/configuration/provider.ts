import generatedMigrations from "./generated/migrations.js";
import { sqliteProvider } from "@barry-rocks/sdk/internal/stores";
export const coreMigrations = generatedMigrations;
export const coreProvider = sqliteProvider(coreMigrations);
