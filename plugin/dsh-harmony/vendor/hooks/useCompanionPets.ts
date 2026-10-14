"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "./useI18n";
import type {
  CompanionPet,
  CompanionPetSourceKind,
  CompanionPetsResponse,
} from "@/lib/companion-pets";

export type CompanionPetSource = CompanionPet & {
  sourceKind?: CompanionPetSourceKind;
  sourceKey?: string;
  origin?: Exclude<CompanionPetSourceKind, "piora-bundled" | "piora-installed">;
};

const COMPANION_PETS_CHANNEL = "pi-companion-pets-v1";

function notifyPetCatalogChanged(): void {
  const channel = new BroadcastChannel(COMPANION_PETS_CHANNEL);
  channel.postMessage({ type: "pets-changed" });
  channel.close();
}

export function getCompanionPetSourceKey(pet: CompanionPetSource): string {
  return pet.sourceKey ?? `${pet.sourceKind ?? pet.source}:${pet.id}`;
}

export function useCompanionPets(active: boolean) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<CompanionPetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingPetKey, setImportingPetKey] = useState<string | null>(null);
  const [importingArchive, setImportingArchive] = useState(false);

  const loadPets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/companion-pets", { cache: "no-store" });
      const body = await response.json() as CompanionPetsResponse | { error?: string };
      if (!response.ok) {
        throw new Error("error" in body && body.error ? body.error : t("companion.loadPetsFailed"));
      }
      setCatalog(body as CompanionPetsResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("companion.loadPetsFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (active) void loadPets();
  }, [active, loadPets]);

  useEffect(() => {
    if (!active) return;
    const channel = new BroadcastChannel(COMPANION_PETS_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (
        event.data
        && typeof event.data === "object"
        && (event.data as { type?: unknown }).type === "pets-changed"
      ) {
        void loadPets();
      }
    };
    return () => channel.close();
  }, [active, loadPets]);

  const importPet = useCallback(async (pet: CompanionPetSource): Promise<CompanionPet | null> => {
    const sourceKey = getCompanionPetSourceKey(pet);
    setImportingPetKey(sourceKey);
    setError(null);
    try {
      const response = await fetch("/api/companion-pets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import",
          id: pet.id,
          ...(pet.sourceKind ? { sourceKind: pet.sourceKind } : {}),
        }),
      });
      const body = await response.json() as { pet?: CompanionPet; error?: string };
      if (!response.ok || !body.pet) throw new Error(body.error || t("companion.importFailed"));
      await loadPets();
      notifyPetCatalogChanged();
      return body.pet;
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : t("companion.importFailed"));
      return null;
    } finally {
      setImportingPetKey(null);
    }
  }, [loadPets, t]);

  const importPetArchive = useCallback(async (file: File): Promise<CompanionPet | null> => {
    setImportingArchive(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      const response = await fetch("/api/companion-pets", { method: "POST", body: formData });
      const body = await response.json() as { pet?: CompanionPet; error?: string };
      if (!response.ok || !body.pet) throw new Error(body.error || t("companion.importFailed"));
      await loadPets();
      notifyPetCatalogChanged();
      return body.pet;
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : t("companion.importFailed"));
      return null;
    } finally {
      setImportingArchive(false);
    }
  }, [loadPets, t]);

  return { catalog, loading, error, importingPetKey, importingArchive, loadPets, importPet, importPetArchive };
}
