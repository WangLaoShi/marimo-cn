/* Copyright 2024 Marimo. All rights reserved. */
import { useCallback, useEffect, useState } from "react";

import {
  sendComponentValues,
  sendInterrupt,
  sendRename,
  sendSave,
} from "@/core/network/requests";

import { Controls } from "@/components/editor/controls/Controls";
import { FilenameInput } from "@/components/editor/header/filename-input";
import { FilenameForm } from "@/components/editor/header/filename-form";
import { WebSocketState } from "./websocket/types";
import { useMarimoWebSocket } from "./websocket/useMarimoWebSocket";
import {
  type LastSavedNotebook,
  notebookIsRunningAtom,
  useCellActions,
  useNotebook,
} from "./cells/cells";
import {
  canUndoDeletes,
  notebookCells,
  notebookNeedsRun,
  notebookNeedsSave,
} from "./cells/utils";
import type { AppConfig, UserConfig } from "./config/config-schema";
import { toggleAppMode, viewStateAtom } from "./mode";
import { useHotkey } from "../hooks/useHotkey";
import { useImperativeModal } from "../components/modal/ImperativeModal";
import {
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { useEvent } from "../hooks/useEvent";
import { Logger } from "../utils/Logger";
import { useAutoSave } from "./saving/useAutoSave";
import { useEventListener } from "../hooks/useEventListener";
import { toast } from "../components/ui/use-toast";
import { SortableCellsProvider } from "../components/sort/SortableCellsProvider";
import { type CellId, HTMLCellId } from "./cells/ids";
import { CellArray } from "../components/editor/renderers/CellArray";
import { RuntimeState } from "./kernel/RuntimeState";
import { CellsRenderer } from "../components/editor/renderers/cells-renderer";
import { getSerializedLayout, useLayoutState } from "./layout/layout";
import { useAtom, useAtomValue } from "jotai";
import { useRunStaleCells } from "../components/editor/cell/useRunCells";
import { formatAll } from "./codemirror/format";
import { cn } from "@/utils/cn";
import { isStaticNotebook } from "./static/static-state";
import { useFilename } from "./saving/filename";
import { getSessionId } from "./kernel/session";
import { updateQueryParams } from "@/utils/urls";
import { AppHeader } from "@/components/editor/header/app-header";
import { AppContainer } from "../components/editor/app-container";

interface AppProps {
  userConfig: UserConfig;
  appConfig: AppConfig;
}

export const EditApp: React.FC<AppProps> = ({ userConfig, appConfig }) => {
  const notebook = useNotebook();
  const { setCells, updateCellCode } = useCellActions();
  const [viewState, setViewState] = useAtom(viewStateAtom);
  const [filename, setFilename] = useFilename();
  const [lastSavedNotebook, setLastSavedNotebook] =
    useState<LastSavedNotebook>();
  const layout = useLayoutState();
  const { openModal, closeModal, openAlert } = useImperativeModal();

  const isEditing = viewState.mode === "edit";
  const isPresenting = viewState.mode === "present";
  const isRunning = useAtomValue(notebookIsRunningAtom);

  function alertSaveFailed() {
    openAlert("Failed to save notebook: not connected to a kernel.");
  }

  // Initialize RuntimeState event-listeners
  useEffect(() => {
    RuntimeState.INSTANCE.start(sendComponentValues);
    return () => {
      RuntimeState.INSTANCE.stop();
    };
  }, []);

  const { connection } = useMarimoWebSocket({
    autoInstantiate: userConfig.runtime.auto_instantiate,
    setCells: (cells, layout) => {
      setCells(cells);
      const names = cells.map((cell) => cell.name);
      const codes = cells.map((cell) => cell.code);
      const configs = cells.map((cell) => cell.config);
      setLastSavedNotebook({ names, codes, configs, layout });
    },
    sessionId: getSessionId(),
  });

  const handleFilenameChange = useEvent(async (name: string | null) => {
    if (connection.state !== WebSocketState.OPEN) {
      alertSaveFailed();
      return null;
    }

    updateQueryParams((params) => {
      if (name === null) {
        params.delete("file");
      } else {
        params.set("file", name);
      }
    });

    return sendRename(name)
      .then(() => {
        setFilename(name);
        // Set document title: app_title takes precedence, then filename, then default
        document.title = appConfig.app_title || name || "Untitled Notebook";
        return name;
      })
      .catch((error) => {
        openAlert(error.message);
        return null;
      });
  });

  // Update document title whenever filename or app_title changes
  useEffect(() => {
    // Set document title: app_title takes precedence, then filename, then default
    document.title = appConfig.app_title || filename || "Untitled Notebook";
  }, [appConfig.app_title, filename]);

  const cells = notebookCells(notebook);
  const cellIds = cells.map((cell) => cell.id);
  const codes = cells.map((cell) => cell.code);
  const cellNames = cells.map((cell) => cell.name);
  const configs = cells.map((cell) => cell.config);
  const needsSave = notebookNeedsSave(notebook, layout, lastSavedNotebook);

  // Save the notebook with the given filename
  const saveNotebook = useEvent((filename: string, userInitiated: boolean) => {
    // Don't save if there are no cells
    if (codes.length === 0) {
      return;
    }

    // Don't save if we are not connected to a kernel
    if (connection.state !== WebSocketState.OPEN) {
      alertSaveFailed();
      return;
    }

    Logger.log("saving to ", filename);
    sendSave({
      cellIds: cellIds,
      codes,
      names: cellNames,
      filename,
      configs,
      layout: getSerializedLayout(),
    }).then(() => {
      if (userInitiated) {
        toast({ title: "Notebook saved" });
        if (userConfig.save.format_on_save) {
          formatAll(updateCellCode);
        }
      }
      setLastSavedNotebook({
        names: cellNames,
        codes,
        configs,
        layout,
      });
    });
  });

  // Save the notebook with the current filename, only if the filename exists
  const saveIfNotebookIsNamed = useEvent((userInitiated = false) => {
    if (filename !== null && connection.state === WebSocketState.OPEN) {
      saveNotebook(filename, userInitiated);
    }
  });

  // Save the notebook with the current filename, or prompt the user to name
  const saveOrNameNotebook = useEvent(() => {
    saveIfNotebookIsNamed(true);

    // Filename does not exist and we are connected to a kernel
    if (filename === null && connection.state !== WebSocketState.CLOSED) {
      openModal(<SaveDialog onClose={closeModal} onSave={handleSaveDialog} />);
    }
  });

  useAutoSave({
    // Only run autosave if the file is named
    onSave: saveIfNotebookIsNamed,
    // Reset autosave when needsSave, or codes/configs have changed
    needsSave: needsSave,
    codes: codes,
    cellConfigs: configs,
    cellNames: cellNames,
    connStatus: connection,
    config: userConfig,
  });

  useEventListener(window, "beforeunload", (e: BeforeUnloadEvent) => {
    if (isStaticNotebook()) {
      return;
    }

    if (needsSave) {
      e.preventDefault();
      return (e.returnValue =
        "You have unsaved changes. Are you sure you want to quit?");
    }
  });

  const handleSaveDialog = (pythonFilename: string) => {
    handleFilenameChange(pythonFilename).then((name) => {
      if (name !== null) {
        saveNotebook(name, true);
      }
    });
  };

  const runStaleCells = useRunStaleCells();

  // Toggle the array's presenting state, and sets a cell to anchor scrolling to
  const togglePresenting = useCallback(() => {
    const outputAreas = document.getElementsByClassName("output-area");
    const viewportEnd =
      window.innerHeight || document.documentElement.clientHeight;
    let cellAnchor: CellId | null = null;

    // Find the first output area that is visible
    // eslint-disable-next-line unicorn/prefer-spread
    for (const elem of Array.from(outputAreas)) {
      const rect = elem.getBoundingClientRect();
      if (
        (rect.top >= 0 && rect.top <= viewportEnd) ||
        (rect.bottom >= 0 && rect.bottom <= viewportEnd)
      ) {
        cellAnchor = HTMLCellId.parse(
          (elem.parentNode as HTMLElement).id as HTMLCellId,
        );
        break;
      }
    }

    setViewState((prev) => ({
      mode: toggleAppMode(prev.mode),
      cellAnchor: cellAnchor,
    }));
    requestAnimationFrame(() => {
      if (cellAnchor === null) {
        return;
      }
      document.getElementById(HTMLCellId.create(cellAnchor))?.scrollIntoView();
    });
  }, [setViewState]);

  // HOTKEYS
  useHotkey("global.runStale", () => {
    runStaleCells();
  });
  useHotkey("global.save", saveOrNameNotebook);
  useHotkey("global.interrupt", () => {
    sendInterrupt();
  });
  useHotkey("global.hideCode", () => {
    togglePresenting();
  });

  const getCellsAsJSON = useEvent(() => {
    return JSON.stringify(
      {
        filename: filename,
        cells: cells.map((cell) => {
          return { name: cell.name, code: cell.code };
        }),
      },
      // no replacer
      null,
      // whitespace for indentation
      2,
    );
  });

  const editableCellsArray = (
    <CellArray
      notebook={notebook}
      connStatus={connection}
      mode={viewState.mode}
      userConfig={userConfig}
      appConfig={appConfig}
    />
  );

  return (
    <>
      <AppContainer
        connectionState={connection.state}
        isRunning={isRunning}
        width={appConfig.width}
      >
        <AppHeader
          connection={connection}
          className={cn("pt-4 sm:pt-12 pb-2 mb-4")}
        >
          {isEditing && (
            <div className="flex items-center justify-center container">
              <FilenameForm
                filename={filename}
                setFilename={handleFilenameChange}
              />
            </div>
          )}
        </AppHeader>

        {/* Don't render until we have a single cell */}
        {cells.length > 0 && (
          <CellsRenderer appConfig={appConfig} mode={viewState.mode}>
            <SortableCellsProvider disabled={!isEditing}>
              {editableCellsArray}
            </SortableCellsProvider>
          </CellsRenderer>
        )}
      </AppContainer>
      <Controls
        filename={filename}
        needsSave={needsSave}
        onSaveNotebook={saveOrNameNotebook}
        getCellsAsJSON={getCellsAsJSON}
        presenting={isPresenting}
        onTogglePresenting={togglePresenting}
        onInterrupt={sendInterrupt}
        onRun={runStaleCells}
        closed={connection.state === WebSocketState.CLOSED}
        running={isRunning}
        needsRun={notebookNeedsRun(notebook)}
        undoAvailable={canUndoDeletes(notebook)}
        appWidth={appConfig.width}
      />
    </>
  );
};

const SaveDialog = (props: {
  onClose: () => void;
  onSave: (filename: string) => void;
}) => {
  const { onClose, onSave } = props;
  const cancelButtonLabel = "Cancel";
  const [filename, setFilename] = useState<string>();
  const handleFilenameChange = (name: string) => {
    setFilename(name);
    if (name.trim()) {
      onSave(name);
      onClose();
    }
  };

  return (
    <DialogContent>
      <DialogTitle>Save notebook</DialogTitle>
      <div className="flex flex-col">
        <Label className="text-md pt-6 px-1">Save as</Label>
        <FilenameInput
          onNameChange={handleFilenameChange}
          placeholderText="filename"
          className="missing-filename"
        />
      </div>
      <DialogFooter>
        <Button
          data-testid="cancel-save-dialog-button"
          aria-label={cancelButtonLabel}
          variant="secondary"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          data-testid="submit-save-dialog-button"
          aria-label="Save"
          variant="default"
          disabled={!filename}
          type="submit"
        >
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};
