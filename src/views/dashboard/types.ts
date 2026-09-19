/**
 * Dashboard Types - Re-export shim
 *
 * Re-exports types from the central types/ports.ts with legacy aliases.
 * Panel components import from here; actual definitions live in types/ports.ts.
 */

// Re-export everything from the central types file
export {
  ToolName,
  TOOL_SCRIPTS,
  COMMAND_PORT,
  STATUS_PORTS,
  QUEUE_PORT,
  PRIORITY,
  KILL_TIERS,
  Command,
  QueueEntry,
  BitnodeStatus,
  DashboardState,
  OverviewCardProps,
  DetailPanelProps,
  NonWorkableFactionProgress,
} from "/types/ports";

// Re-export with Formatted* aliases for backward compatibility
export type { NukeStatus as FormattedNukeStatus } from "/types/ports";
export type { PservStatus as FormattedPservStatus } from "/types/ports";
export type { ShareStatus as FormattedShareStatus } from "/types/ports";
export type { RepStatus as FormattedRepStatus } from "/types/ports";
export type { DarkwebStatus as FormattedDarkwebStatus } from "/types/ports";
export type { WorkStatus as FormattedWorkStatus } from "/types/ports";
export type { HackStatus as FormattedHackStatus } from "/types/ports";
export type { TargetAssignment as FormattedTargetAssignment } from "/types/ports";
export type { FactionStatus as FormattedFactionStatus } from "/types/ports";
export type { InfiltrationStatus as FormattedInfiltrationStatus } from "/types/ports";
export type { GangStatus as FormattedGangStatus } from "/types/ports";
export type { GangTerritoryStatus as FormattedGangTerritoryStatus } from "/types/ports";
export type { AugmentsStatus as FormattedAugmentsStatus } from "/types/ports";
export type { AdvisorStatus as FormattedAdvisorStatus } from "/types/ports";
export type { ContractsStatus as FormattedContractsStatus } from "/types/ports";
export type { BudgetStatus as FormattedBudgetStatus } from "/types/ports";
export type { StocksStatus as FormattedStocksStatus } from "/types/ports";
export type { HomeStatus as FormattedHomeStatus } from "/types/ports";
export type { CorpStatus as FormattedCorpStatus } from "/types/ports";
export type { BladeburnerStatus as FormattedBladeburnerStatus } from "/types/ports";
export type { HacknetStatus as FormattedHacknetStatus } from "/types/ports";
export type { DarknetStatus as FormattedDarknetStatus } from "/types/ports";

// Legacy plugin interface (kept for any remaining references)
import React from "lib/react";
import { ToolName, OverviewCardProps, DetailPanelProps } from "/types/ports";

export interface ToolPlugin<TFormatted> {
  name: string;
  id: ToolName;
  script: string;
  OverviewCard: React.ComponentType<OverviewCardProps<TFormatted>>;
  DetailPanel: React.ComponentType<DetailPanelProps<TFormatted>>;
}
