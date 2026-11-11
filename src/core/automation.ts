import type { Config } from "./config.ts";
import type { KaneoAdminClient } from "./kaneo.ts";
import type { Logger } from "./logger.ts";

export type AutomationStatus = {
  name: string;
  healthy: boolean;
  detail: Record<string, unknown>;
};

export type AutomationContext = {
  config: Config;
  kaneo: KaneoAdminClient;
  logger: Logger;
  /** Postgres settings for automations that need LISTEN. */
  database: Config["database"];
};

export type Automation = {
  name: string;
  start: (context: AutomationContext) => Promise<void> | void;
  stop: () => Promise<void> | void;
  status: () => AutomationStatus;
};

export type AutomationFactory = () => Automation;
