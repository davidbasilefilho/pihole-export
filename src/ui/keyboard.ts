import { useKeyboard } from "@opentui/solid";

import type { Screen } from "./focus";

export interface WorkbenchKeyboard {
  readonly screen: () => Screen;
  readonly busy: () => boolean;
  readonly quit: () => void;
  readonly moveConnectFocus: (delta: number) => void;
  readonly connectFocus: () => string;
  readonly toggleScheme: () => void;
  readonly cycleAuth: (delta: number) => void;
  readonly connect: () => void;
  readonly moveFilterFocus: (delta: number) => void;
  readonly filterFocus: () => number;
  readonly toggleDisk: () => void;
  readonly toggleLiveSetting: () => void;
  readonly openSuggestions: () => void;
  readonly openPresets: () => void;
  readonly submitFilters: () => void;
  readonly stopWork: () => void;
  readonly moveResultFocus: (delta: number) => void;
  readonly moveSelection: (delta: number) => void;
  readonly activateResult: () => void;
  readonly resultAction: (index: number) => void;
  readonly rerun: () => void;
  readonly moveDialogFocus: (delta: number, count: number) => void;
  readonly moveSuggestion: (delta: number) => void;
  readonly applySuggestion: () => void;
  readonly showFilters: () => void;
  readonly acceptConfirm: () => void;
  readonly showResults: () => void;
  readonly activateInspect: () => void;
  readonly activateSearch: () => void;
  readonly cycleExportFormat: (delta: number) => void;
  readonly exportRows: () => void;
  readonly cancelExport: () => void;
  readonly presetControlCount: () => number;
  readonly activatePreset: () => void;
  readonly closePreset: () => void;
  readonly closeOverlay: () => void;
}

export const useWorkbenchKeyboard = (actions: WorkbenchKeyboard) =>
  useKeyboard((key) => {
    const current = actions.screen();
    if (key.ctrl && key.name === "c") return actions.quit();
    if (current === "connect") {
      if (key.name === "tab") {
        key.preventDefault();
        actions.moveConnectFocus(key.shift ? -1 : 1);
      } else if (key.name === "escape") actions.quit();
      else if (
        actions.connectFocus() === "scheme" &&
        ["left", "right", "space", "return"].includes(key.name)
      )
        actions.toggleScheme();
      else if (
        actions.connectFocus() === "auth" &&
        ["left", "right", "space", "return"].includes(key.name)
      )
        actions.cycleAuth(key.name === "left" ? -1 : 1);
      else if (actions.connectFocus() === "connect" && key.name === "return") actions.connect();
      return;
    }
    if (current === "filters") {
      if (key.name === "tab") {
        key.preventDefault();
        actions.moveFilterFocus(key.shift ? -1 : 1);
      } else if (key.name === "escape") actions.quit();
      else if (key.ctrl && key.name === "space") actions.openSuggestions();
      else if (actions.filterFocus() === 11 && ["space", "return"].includes(key.name))
        actions.toggleDisk();
      else if (actions.filterFocus() === 12 && ["space", "return"].includes(key.name))
        actions.toggleLiveSetting();
      else if (actions.filterFocus() === 13 && key.name === "return") actions.openPresets();
      else if (actions.filterFocus() === 14 && key.name === "return") actions.submitFilters();
      return;
    }
    if (current === "results") {
      if (actions.busy() && key.name === "escape") return actions.stopWork();
      if (key.name === "tab") {
        key.preventDefault();
        actions.moveResultFocus(key.shift ? -1 : 1);
      } else if (key.name === "down" || key.name === "j") actions.moveSelection(1);
      else if (key.name === "up" || key.name === "k") actions.moveSelection(-1);
      else if (key.name === "return") actions.activateResult();
      else if (key.name === "/") actions.resultAction(0);
      else if (key.name === "s") actions.resultAction(1);
      else if (key.name === "a") actions.resultAction(2);
      else if (key.name === "l") actions.resultAction(3);
      else if (key.name === "x") actions.resultAction(4);
      else if (key.name === "e") actions.resultAction(5);
      else if (key.name === "p") actions.resultAction(6);
      else if (key.name === "f" || key.name === "escape") actions.resultAction(7);
      else if (key.name === "?") actions.resultAction(8);
      else if (key.name === "r") actions.rerun();
      else if (key.name === "q") actions.quit();
      return;
    }
    if (current === "suggestions") {
      if (key.name === "tab") actions.moveDialogFocus(key.shift ? -1 : 1, 3);
      else if (key.name === "down" || key.name === "j") actions.moveSuggestion(1);
      else if (key.name === "up" || key.name === "k") actions.moveSuggestion(-1);
      else if (key.name === "return") actions.applySuggestion();
      else if (key.name === "escape") actions.showFilters();
      return;
    }
    if (current === "confirm") {
      if (key.name === "tab") actions.moveDialogFocus(key.shift ? -1 : 1, 2);
      else if (key.name === "return") actions.acceptConfirm();
      else if (key.name === "escape" || key.name === "n") actions.showFilters();
      return;
    }
    if (current === "inspect") {
      if (key.name === "tab") actions.moveDialogFocus(key.shift ? -1 : 1, 7);
      else if (key.name === "escape") actions.showResults();
      else if (key.name === "return") actions.activateInspect();
      return;
    }
    if (current === "search") {
      if (key.name === "tab") actions.moveDialogFocus(key.shift ? -1 : 1, 4);
      else if (key.name === "escape") actions.showResults();
      else if (key.name === "return") actions.activateSearch();
      return;
    }
    if (current === "export") {
      if (key.name === "tab") actions.moveDialogFocus(key.shift ? -1 : 1, 4);
      else if (key.name === "escape") actions.cancelExport();
      else if (["left", "right", "space"].includes(key.name))
        actions.cycleExportFormat(key.name === "left" ? -1 : 1);
      else if (key.name === "return") actions.exportRows();
      return;
    }
    if (current === "presets") {
      if (key.name === "tab")
        actions.moveDialogFocus(key.shift ? -1 : 1, actions.presetControlCount());
      else if (key.name === "escape") actions.closePreset();
      else if (key.name === "return") actions.activatePreset();
      return;
    }
    if (key.name === "escape" || key.name === "q" || key.name === "return") actions.closeOverlay();
  });
