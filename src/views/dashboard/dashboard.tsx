/**
 * React Dashboard for Auto Tools
 *
 * Port-based dashboard: reads status from ports published by daemons.
 * Uses a two-tier grouped tab layout and data-driven plugin registry.
 */
import React from "lib/react";
import { NS } from "@ns";

const { useState, useEffect, useRef } = React;

// Types and state
import { DashboardState, ToolName } from "views/dashboard/types";
import { ToolPlugin } from "views/dashboard/types";
import {
  TabState,
  initCommandPort,
  readAndExecuteCommands,
  readStatusPorts,
  getActiveTab,
  setActiveTab,
  detectRunningTools,
  getStateSnapshot,
  loadDashboardSettings,
  sendResetStartConfig,
} from "views/dashboard/state-store";
// Styles and components
import { styles } from "views/dashboard/styles";
import { GroupedTabBar, TabGroup, ToolStatus } from "views/dashboard/components/TabBar";
import { ErrorBoundary } from "views/dashboard/components/ErrorBoundary";
import { BitnodeStatusBar } from "views/dashboard/components/BitnodeStatus";

// Tool plugins
import { nukePlugin } from "views/dashboard/tools/nuke";
import { pservPlugin } from "views/dashboard/tools/pserv";
import { sharePlugin } from "views/dashboard/tools/share";
import { repPlugin } from "views/dashboard/tools/rep";
import { hackPlugin } from "views/dashboard/tools/hack";
import { darkwebPlugin } from "views/dashboard/tools/darkweb";
import { darknetPlugin } from "views/dashboard/tools/darknet";
import { workPlugin } from "views/dashboard/tools/work";
import { factionPlugin } from "views/dashboard/tools/faction";
import { infiltrationPlugin } from "views/dashboard/tools/infiltration";
import { gangPlugin } from "views/dashboard/tools/gang";
import { augmentsPlugin } from "views/dashboard/tools/augments";
import { advisorPlugin } from "views/dashboard/tools/advisor";
import { contractsPlugin } from "views/dashboard/tools/contracts";
import { budgetPlugin } from "views/dashboard/tools/budget";
import { stocksPlugin } from "views/dashboard/tools/stocks";
import { casinoPlugin } from "views/dashboard/tools/casino";
import { homePlugin } from "views/dashboard/tools/home";
import { corpPlugin } from "views/dashboard/tools/corp";
import { bladePlugin } from "views/dashboard/tools/blade";
import { hacknetPlugin } from "views/dashboard/tools/hacknet";
import { focusPlugin, FocusStickyHeader } from "views/dashboard/tools/focus";

// === PLUGIN REGISTRY ===

/** Helper to pluck a field from DashboardState by key name. */
function pick<K extends keyof DashboardState>(key: K): (s: DashboardState) => DashboardState[K] {
  return (s: DashboardState) => s[key];
}

interface PluginEntry {
  toolId: ToolName;
  // The registry is intentionally heterogeneous (each plugin has its own
  // TFormatted status type) — `any` here is a deliberate type-erasure
  // escape hatch, not an oversight.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin: ToolPlugin<any>;
  tabLabel: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStatus: (s: DashboardState) => any;
  getError: (s: DashboardState) => string | null;
}

/** Flat registry of all plugins — used by OverviewPanel. */
const PLUGIN_REGISTRY: PluginEntry[] = [
  { toolId: "nuke",         plugin: nukePlugin,         tabLabel: "Nuke",       getStatus: pick("nukeStatus"),         getError: () => null },
  { toolId: "hack",         plugin: hackPlugin,         tabLabel: "Hack",       getStatus: pick("hackStatus"),         getError: () => null },
  { toolId: "pserv",        plugin: pservPlugin,        tabLabel: "PServ",      getStatus: pick("pservStatus"),        getError: () => null },
  { toolId: "darkweb",      plugin: darkwebPlugin,      tabLabel: "Darkweb",    getStatus: pick("darkwebStatus"),      getError: pick("darkwebError") as (s: DashboardState) => string | null },
  { toolId: "darknet",      plugin: darknetPlugin,      tabLabel: "Darknet",    getStatus: pick("darknetStatus"),      getError: () => null },
  { toolId: "faction",      plugin: factionPlugin,      tabLabel: "Faction",    getStatus: pick("factionStatus"),      getError: pick("factionError") as (s: DashboardState) => string | null },
  { toolId: "rep",          plugin: repPlugin,          tabLabel: "Rep",        getStatus: pick("repStatus"),          getError: pick("repError") as (s: DashboardState) => string | null },
  { toolId: "share",        plugin: sharePlugin,        tabLabel: "Share",      getStatus: pick("shareStatus"),        getError: () => null },
  { toolId: "augments",     plugin: augmentsPlugin,     tabLabel: "Augs",       getStatus: pick("augmentsStatus"),     getError: () => null },
  { toolId: "work",         plugin: workPlugin,         tabLabel: "Work",       getStatus: pick("workStatus"),         getError: pick("workError") as (s: DashboardState) => string | null },
  { toolId: "gang",         plugin: gangPlugin,         tabLabel: "Gang",       getStatus: pick("gangStatus"),         getError: () => null },
  { toolId: "infiltration", plugin: infiltrationPlugin, tabLabel: "Infiltrate", getStatus: pick("infiltrationStatus"), getError: () => null },
  { toolId: "advisor",      plugin: advisorPlugin,      tabLabel: "Advisor",    getStatus: pick("advisorStatus"),       getError: () => null },
  { toolId: "contracts",    plugin: contractsPlugin,    tabLabel: "Contracts",  getStatus: pick("contractsStatus"),    getError: () => null },
  { toolId: "budget",       plugin: budgetPlugin,       tabLabel: "Budget",     getStatus: pick("budgetStatus"),       getError: () => null },
  { toolId: "stocks",       plugin: stocksPlugin,       tabLabel: "Stocks",     getStatus: pick("stocksStatus"),       getError: () => null },
  { toolId: "casino",       plugin: casinoPlugin,       tabLabel: "Casino",     getStatus: pick("casinoStatus"),       getError: () => null },
  { toolId: "home",         plugin: homePlugin,         tabLabel: "Home",       getStatus: pick("homeStatus"),         getError: () => null },
  { toolId: "corp",         plugin: corpPlugin,         tabLabel: "Corp",       getStatus: pick("corpStatus"),         getError: () => null },
  { toolId: "blade",        plugin: bladePlugin,        tabLabel: "Blade",      getStatus: pick("bladeburnerStatus"),  getError: () => null },
  { toolId: "hacknet",      plugin: hacknetPlugin,      tabLabel: "Hacknet",    getStatus: pick("hacknetStatus"),      getError: () => null },
  { toolId: "focus",        plugin: focusPlugin,        tabLabel: "Focus",      getStatus: pick("focusStatus"),        getError: () => null },
];

/** Lookup a PluginEntry by toolId. */
function findEntry(toolId: ToolName): PluginEntry {
  return PLUGIN_REGISTRY.find(e => e.toolId === toolId)!;
}

/** Tab groups with references to their PluginEntries. */
interface TabGroupDef {
  label: string;
  entries: PluginEntry[];
}

/** Index of the Focus group in TAB_GROUPS (used for conditional rendering). */
const FOCUS_GROUP_INDEX = 1;

const TAB_GROUPS: TabGroupDef[] = [
  { label: "Servers",  entries: [findEntry("home"), findEntry("nuke"), findEntry("hack"), findEntry("pserv"), findEntry("darkweb"), findEntry("darknet")] },
  { label: "Focus",    entries: [findEntry("focus"), findEntry("work"), findEntry("rep"), findEntry("blade")] },
  { label: "Factions", entries: [findEntry("faction"), findEntry("share"), findEntry("augments")] },
  { label: "Money",    entries: [findEntry("budget"), findEntry("stocks"), findEntry("hacknet"), findEntry("gang"), findEntry("corp")] },
  { label: "Tools",    entries: [findEntry("casino"), findEntry("infiltration"), findEntry("contracts")] },
];

/** Build the TabGroup[] shape needed by GroupedTabBar. */
const TAB_GROUP_PROPS: TabGroup[] = TAB_GROUPS.map(g => ({
  label: g.label,
  subLabels: g.entries.map(e => e.tabLabel),
}));

// === OVERVIEW PANEL ===

/** Find the (group, sub) tab indices for a given toolId. */
function findTabForTool(toolId: ToolName): { group: number; sub: number } | null {
  for (let g = 0; g < TAB_GROUPS.length; g++) {
    for (let s = 0; s < TAB_GROUPS[g].entries.length; s++) {
      if (TAB_GROUPS[g].entries[s].toolId === toolId) return { group: g, sub: s };
    }
  }
  return null;
}

interface OverviewPanelProps {
  state: DashboardState;
  onNavigate: (toolId: ToolName) => void;
}

function StartupConfigPanel({ config }: { config: DashboardState["startupConfig"] }): React.ReactElement {
  if (config.length === 0) {
    return (
      <div style={{ ...styles.cardOverview, padding: "8px 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
          <span style={{ color: "#888", fontSize: "11px", fontWeight: "bold" }}>STARTUP CONFIG</span>
        </div>
        <span style={{ color: "#666", fontSize: "11px" }}>No /config/start.txt found. Run start.js to generate defaults.</span>
      </div>
    );
  }

  const coreEntries = config.filter(e => e.core);
  const optionalEntries = config.filter(e => !e.core);
  const disabledCount = config.filter(e => !e.enabled).length;

  const nameFromPath = (path: string) => path.replace(/^daemons\//, "").replace(/\.js$/, "");

  const renderEntries = (entries: typeof config) => (
    <span style={{ fontSize: "11px", lineHeight: "1.6" }}>
      {entries.map((e, i) => (
        <span key={e.path}>
          <span style={{ color: e.enabled ? "#00ff00" : "#555", textDecoration: e.enabled ? "none" : "line-through" }}>
            {nameFromPath(e.path)}
          </span>
          {i < entries.length - 1 && <span style={{ color: "#333" }}>{" | "}</span>}
        </span>
      ))}
    </span>
  );

  return (
    <div style={{ ...styles.cardOverview, padding: "8px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
        <span style={{ color: "#888", fontSize: "11px", fontWeight: "bold" }}>
          STARTUP CONFIG
          {disabledCount > 0 && <span style={{ color: "#ff8800" }}>{" "}({disabledCount} disabled)</span>}
        </span>
        <button
          style={{
            backgroundColor: "#1a1a1a",
            color: "#888",
            border: "1px solid #444",
            borderRadius: "3px",
            padding: "1px 6px",
            fontSize: "10px",
            fontFamily: "inherit",
            cursor: "pointer",
          }}
          onClick={() => sendResetStartConfig()}
        >
          Reset Defaults
        </button>
      </div>
      <div style={{ marginBottom: "4px" }}>
        <span style={{ color: "#666", fontSize: "10px" }}>CORE: </span>
        {renderEntries(coreEntries)}
      </div>
      <div>
        <span style={{ color: "#666", fontSize: "10px" }}>OPT: </span>
        {renderEntries(optionalEntries)}
      </div>
      <div style={{ color: "#555", fontSize: "10px", marginTop: "4px" }}>
        vim /config/start.txt to edit
      </div>
    </div>
  );
}

function OverviewPanel({ state, onNavigate }: OverviewPanelProps): React.ReactElement {
  const advisorEntry = findEntry("advisor");
  const AdvisorPanel = advisorEntry.plugin.DetailPanel;

  return (
    <div>
      <div style={{ marginBottom: "12px" }}>
        <ErrorBoundary label="Bitnode">
          <BitnodeStatusBar status={state.bitnodeStatus} />
        </ErrorBoundary>
      </div>
      <div style={{ marginBottom: "12px" }}>
        <ErrorBoundary label="Advisor">
          <AdvisorPanel
              status={advisorEntry.getStatus(state)}
              running={state.pids[advisorEntry.toolId] > 0}
              toolId={advisorEntry.toolId}
              error={advisorEntry.getError(state)}
              pid={state.pids[advisorEntry.toolId]}
          />
        </ErrorBoundary>
      </div>
      <div style={{ marginBottom: "12px" }}>
        <StartupConfigPanel config={state.startupConfig} />
      </div>
      <div style={styles.grid}>
        {PLUGIN_REGISTRY.filter(e => e.toolId !== "advisor").map(entry => {
          const Card = entry.plugin.OverviewCard;
          return (
            <div
              key={entry.toolId}
              style={{ cursor: "pointer" }}
              onClick={() => onNavigate(entry.toolId)}
            >
              <ErrorBoundary label={entry.tabLabel}>
                <Card
                  status={entry.getStatus(state)}
                  running={state.pids[entry.toolId] > 0}
                  toolId={entry.toolId}
                  error={entry.getError(state)}
                  pid={state.pids[entry.toolId]}
                />
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// === MAIN DASHBOARD ===

function Dashboard(): React.ReactElement {
  const [state, setState] = useState<DashboardState>(getStateSnapshot());
  const [tabState, setTabStateLocal] = useState<TabState>(getActiveTab());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rootRef.current) return;
    let parent = rootRef.current.parentElement?.parentElement;
    if(parent) {
      parent.style.overflowY = 'auto';
      parent = parent.parentElement;
    }
    if (parent) {
      parent.style.justifyContent = 'start';
    }
  }, []);

  // Poll module-level state every 200ms
  useEffect(() => {
    const intervalId = setInterval(() => {
      setState(getStateSnapshot());
    }, 200);
    return () => clearInterval(intervalId);
  }, []);

  const handleOverviewClick = () => {
    const next: TabState = { group: -1, sub: 0 };
    setActiveTab(next);
    setTabStateLocal(next);
  };

  const handleGroupClick = (groupIndex: number) => {
    const next: TabState = { group: groupIndex, sub: 0 };
    setActiveTab(next);
    setTabStateLocal(next);
  };

  const handleSubClick = (subIndex: number) => {
    const next: TabState = { group: tabState.group, sub: subIndex };
    setActiveTab(next);
    setTabStateLocal(next);
  };

  const handleNavigate = (toolId: ToolName) => {
    const pos = findTabForTool(toolId);
    if (pos) {
      const next: TabState = { group: pos.group, sub: pos.sub };
      setActiveTab(next);
      setTabStateLocal(next);
    }
  };

  const renderPanel = () => {
    if (tabState.group === -1) {
      return <OverviewPanel state={state} onNavigate={handleNavigate} />;
    }

    const group = TAB_GROUPS[tabState.group];
    if (!group) return <div style={styles.panel}>Unknown group</div>;

    const entry = group.entries[tabState.sub];
    if (!entry) return <div style={styles.panel}>Unknown tab</div>;

    const Panel = entry.plugin.DetailPanel;
    const isFocusGroup = tabState.group === FOCUS_GROUP_INDEX;

    return (
      <div>
        {isFocusGroup && tabState.sub !== 0 && <FocusStickyHeader status={state.focusStatus} />}
        <ErrorBoundary label={entry.tabLabel}>
          <Panel
            status={entry.getStatus(state)}
            running={state.pids[entry.toolId] > 0}
            toolId={entry.toolId}
            error={entry.getError(state)}
            pid={state.pids[entry.toolId]}
          />
        </ErrorBoundary>
      </div>
    );
  };

  return (
    <div ref={rootRef} style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>AUTO TOOLS DASHBOARD</h1>
      </div>
      <GroupedTabBar
        groups={TAB_GROUP_PROPS}
        activeGroup={tabState.group}
        activeSub={tabState.sub}
        onOverviewClick={handleOverviewClick}
        onGroupClick={handleGroupClick}
        onSubClick={handleSubClick}
        statuses={TAB_GROUPS.map(g => g.entries.map((e): ToolStatus => {
          if (state.pids[e.toolId] > 0) return "running";
          if (e.toolId === "darkweb" && state.darkwebStatus?.allOwned) return "completed";
          if (e.toolId === "pserv" && state.pservStatus?.allMaxed && state.pservStatus.serverCount >= state.pservStatus.serverCap) return "completed";
          return "stopped";
        }))}
      />
      {renderPanel()}
    </div>
  );
}

// === MAIN LOOP ===

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.resizeTail(600, 700);

  // Initialize the command port for React→MainLoop communication
  initCommandPort(ns);
  loadDashboardSettings(ns);
  ns.clearLog()
  ns.printRaw(<Dashboard />);

  while (true) {
    // 1. Process any pending commands first (responsive to clicks)
    readAndExecuteCommands(ns);

    // 2. Detect running tools (finds scripts started manually or before restart)
    detectRunningTools(ns);

    // 3. Read status from ports (published by daemons)
    readStatusPorts(ns);

    // 4. Short sleep with command polling for responsive UI
    const TICK_MS = 100;
    const TOTAL_MS = 500;
    for (let elapsed = 0; elapsed < TOTAL_MS; elapsed += TICK_MS) {
      readAndExecuteCommands(ns);
      await ns.sleep(TICK_MS);
    }
  }
}
