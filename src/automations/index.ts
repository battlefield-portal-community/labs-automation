import type { AutomationFactory } from "../core/automation.ts";
import { createAutoJoinAutomation } from "./auto-join.ts";

/**
 * Every automation in this image, keyed by the name used in AUTOMATIONS.
 * Add a factory here and it can be enabled per deployment without a code change
 * to the hub.
 */
export const AUTOMATIONS: Record<string, AutomationFactory> = {
  "auto-join": createAutoJoinAutomation,
};

export const AUTOMATION_NAMES = Object.keys(AUTOMATIONS);
