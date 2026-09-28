import * as vscode from "vscode";
import { VersionCache } from "./core/cache";
import { VersionCodeLensProvider } from "./core/codeLensProvider";
import { VersionCodeActionProvider } from "./core/codeActionProvider";
import { LanguageProvider, PackageInfo } from "./core/types";
import { NpmProvider } from "./providers/npm";
import { CargoProvider } from "./providers/cargo";
import { GoProvider } from "./providers/go";
import { ComposerProvider } from "./providers/composer";
import { compareSemver, extractSemver } from "./utils/semver";
import { setNpmCacheTtl, clearNpmCache } from "./providers/npm/registry";
import { setCargoCacheTtl, clearCargoCache } from "./providers/cargo/registry";
import { setGoCacheTtl, clearGoCache } from "./providers/go/registry";
import { setComposerCacheTtl, clearComposerCache } from "./providers/composer/registry";
import { DartProvider } from "./providers/dart";
import { setDartCacheTtl, clearDartCache } from "./providers/dart/registry";

const PROVIDER_SELECTORS: Record<string, vscode.DocumentSelector> = {
  npm: [{ pattern: "**/package.json" }],
  cargo: [{ pattern: "**/Cargo.toml" }],
  go: [{ pattern: "**/go.mod" }],
  composer: [{ pattern: "**/composer.json" }],
  dart: [{ pattern: "**/pubspec.yaml" }]
};

function setAllRegistryCacheTtl(ttlMs: number) {
  setNpmCacheTtl(ttlMs);
  setCargoCacheTtl(ttlMs);
  setGoCacheTtl(ttlMs);
  setComposerCacheTtl(ttlMs);
  setDartCacheTtl(ttlMs);
}

function clearAllRegistryCaches() {
  clearNpmCache();
  clearCargoCache();
  clearGoCache();
  clearComposerCache();
  clearDartCache();
}

function ensureGlyphMargin() {
  const editorConfig = vscode.workspace.getConfiguration("editor");
  const glyphMargin = editorConfig.get<boolean>("glyphMargin");
  if (!glyphMargin) {
    void editorConfig.update("glyphMargin", true, vscode.ConfigurationTarget.Global);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("versionCheck");
  const providersConfig = config.get<Record<string, boolean>>("providers", {});
  const ttlSeconds = config.get<number>("cacheTtlSeconds", 300);
  const ttlMs = ttlSeconds * 1000;

  ensureGlyphMargin();

  const allProviders: LanguageProvider[] = [
    new NpmProvider(),
    new CargoProvider(),
    new GoProvider(),
    new ComposerProvider(),
    new DartProvider()
  ];

  const enabledProviders = allProviders.filter((provider) => {
    const enabled = providersConfig[provider.id];
    return enabled !== false;
  });

  // Set TTL for all registry caches
  setAllRegistryCacheTtl(ttlMs);

  const cache = new VersionCache(ttlMs);
  const codeLensProvider = new VersionCodeLensProvider(
    enabledProviders,
    cache,
    context
  );
  const codeActionProvider = new VersionCodeActionProvider(enabledProviders);

  context.subscriptions.push({ dispose: () => codeLensProvider.dispose() });

  for (const provider of enabledProviders) {
    const selector = PROVIDER_SELECTORS[provider.id];
    if (!selector) {
      continue;
    }
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(selector, codeLensProvider)
    );
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(selector, codeActionProvider, {
        providedCodeActionKinds: VersionCodeActionProvider.providedCodeActionKinds
      })
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "versionCheck.updateDependency",
      async (uri: vscode.Uri | string, providerId: string, info: PackageInfo, latest?: string, direct?: boolean) => {
        const provider = enabledProviders.find((item) => item.id === providerId);
        if (!provider) {
          return;
        }
        if (provider.shouldSkipVersion?.(info.currentVersion)) {
          return;
        }
        const documentUri = uri instanceof vscode.Uri ? uri : vscode.Uri.parse(String(uri));
        const document = await vscode.workspace.openTextDocument(documentUri);
        const fresh = findFreshPackage(provider, document, info);
        if (!fresh) {
          return;
        }
        // direct=true: apply the latest version immediately without prompting.
        // Otherwise open the version picker.
        const chosenVersion = direct && latest
          ? latest
          : await pickVersion(provider, fresh, latest);
        if (!chosenVersion) {
          return;
        }
        const latestFresh = findFreshPackage(provider, document, info) ?? fresh;
        const newVersion = provider.formatUpdatedVersion(latestFresh.currentVersion, chosenVersion);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(documentUri, coerceRange(latestFresh.range), newVersion);
        await vscode.workspace.applyEdit(edit);
        codeLensProvider.refresh();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "versionCheck.updateAllInSection",
      async (
        uri: vscode.Uri | string,
        providerId: string,
        updates: Array<{ info: PackageInfo; latestVersion: string | undefined }>
      ) => {
        const provider = enabledProviders.find((item) => item.id === providerId);
        if (!provider || !updates.length) {
          return;
        }
        const documentUri = uri instanceof vscode.Uri ? uri : vscode.Uri.parse(String(uri));
        const document = await vscode.workspace.openTextDocument(documentUri);
        const freshByKey = indexPackages(provider.parseDocument(document));
        const edit = new vscode.WorkspaceEdit();

        const sortedUpdates = [...updates].sort(
          (a, b) => b.info.range.start.line - a.info.range.start.line
        );

        for (const { info, latestVersion } of sortedUpdates) {
          if (!latestVersion) {
            continue;
          }
          const fresh = freshByKey.get(packageKey(info));
          if (!fresh) {
            continue;
          }
          if (provider.shouldSkipVersion?.(fresh.currentVersion)) {
            continue;
          }
          const newVersion = provider.formatUpdatedVersion(fresh.currentVersion, latestVersion);
          edit.replace(documentUri, coerceRange(fresh.range), newVersion);
        }

        await vscode.workspace.applyEdit(edit);
        codeLensProvider.refresh();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("versionCheck.refresh", () => {
      cache.clear();
      clearAllRegistryCaches();
      codeLensProvider.fullRefresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("versionCheck.clearCache", () => {
      cache.clear();
      clearAllRegistryCaches();
      vscode.window.showInformationMessage("Version Check: Cache cleared");
    })
  );
}

export function deactivate() { }

type VersionPickItem = vscode.QuickPickItem & { version?: string; action?: "custom" };

function coerceRange(range: vscode.Range | { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  if (range instanceof vscode.Range) {
    return range;
  }
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}

function packageKey(info: Pick<PackageInfo, "name" | "dependencyGroup">): string {
  return `${info.dependencyGroup ?? ""}::${info.name}`;
}

function indexPackages(packages: PackageInfo[]): Map<string, PackageInfo> {
  const map = new Map<string, PackageInfo>();
  for (const pkg of packages) {
    map.set(packageKey(pkg), pkg);
  }
  return map;
}

function findFreshPackage(
  provider: LanguageProvider,
  document: vscode.TextDocument,
  info: PackageInfo
): PackageInfo | undefined {
  const packages = provider.parseDocument(document);
  return packages.find(
    (pkg) => pkg.name === info.name && pkg.dependencyGroup === info.dependencyGroup
  );
}

function getIgnorePatterns(): string[] {
  const config = vscode.workspace.getConfiguration("versionCheck");
  return config.get<string[]>("ignorePrereleasePatterns", []);
}

async function pickVersion(
  provider: LanguageProvider,
  info: PackageInfo,
  latestHint?: string
): Promise<string | null> {
  const ignorePatterns = getIgnorePatterns();
  const quickPick = vscode.window.createQuickPick<VersionPickItem>();
  quickPick.placeholder = `Select version for ${info.name}`;
  quickPick.matchOnDescription = true;

  let latest = latestHint;
  let available: string[] | null | undefined = undefined;
  let closed = false;

  const updateItems = () => {
    quickPick.items = buildVersionPickItems(info, latest, available);
  };

  updateItems();
  quickPick.busy = true;

  const latestPromise = latest
    ? Promise.resolve(latest)
    : provider.getLatestVersion(info.name, ignorePatterns).catch(() => null);
  const availablePromise = provider.getAvailableVersions(info.name).catch(() => null);

  latestPromise.then((value) => {
    if (closed || !value || value === latest) {
      return;
    }
    latest = value;
    updateItems();
  });

  availablePromise.then((versions) => {
    if (closed) {
      return;
    }
    available = versions;
    updateItems();
  });

  Promise.allSettled([latestPromise, availablePromise]).then(() => {
    if (!closed) {
      quickPick.busy = false;
    }
  });

  return new Promise((resolve) => {
    quickPick.onDidAccept(async () => {
      const selection = quickPick.selectedItems[0];
      if (!selection) {
        return;
      }
      closed = true;
      quickPick.hide();
      quickPick.dispose();

      if (selection.action === "custom") {
        const value = await promptVersionInput(info, latest);
        resolve(value);
        return;
      }
      if (selection.version) {
        resolve(selection.version);
        return;
      }
      resolve(null);
    });

    quickPick.onDidHide(() => {
      if (closed) {
        return;
      }
      closed = true;
      quickPick.dispose();
      resolve(null);
    });

    quickPick.show();
  });
}

async function promptVersionInput(
  info: PackageInfo,
  latest?: string
): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    prompt: `Enter version for ${info.name}`,
    value: latest
  });
  return value?.trim() || null;
}

function sortVersionsDesc(versions: string[]): string[] {
  const unique = Array.from(
    new Set(versions.map((version) => version.trim()).filter(Boolean))
  );

  return unique.sort((a, b) => {
    const aSemver = extractSemver(a);
    const bSemver = extractSemver(b);
    if (aSemver && bSemver) {
      return compareSemver(bSemver, aSemver);
    }
    if (aSemver) {
      return -1;
    }
    if (bSemver) {
      return 1;
    }
    return b.localeCompare(a);
  });
}

function buildVersionPickItems(
  info: PackageInfo,
  latest: string | undefined,
  available: string[] | null | undefined
): VersionPickItem[] {
  const versions = available?.length ? available : [];
  const merged = latest ? [...versions, latest] : [...versions];
  const sorted = sortVersionsDesc(merged);

  const items: VersionPickItem[] = [
    {
      label: "Custom...",
      description: "Enter version manually",
      action: "custom"
    }
  ];

  for (const version of sorted) {
    items.push({
      label: version,
      description: describeVersion(version, info.currentVersion, latest),
      version
    });
  }

  return items;
}

function describeVersion(
  version: string,
  currentVersion: string,
  latest?: string
): string | undefined {
  if (latest && isSameVersion(version, latest)) {
    return "latest";
  }
  if (isSameVersion(version, currentVersion)) {
    return "current";
  }
  return undefined;
}

function isSameVersion(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  const leftSemver = extractSemver(left);
  const rightSemver = extractSemver(right);
  if (leftSemver && rightSemver) {
    return compareSemver(leftSemver, rightSemver) === 0;
  }
  return left.trim() === right.trim();
}
