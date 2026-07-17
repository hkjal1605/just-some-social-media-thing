// Global category filter (doc 10 §2), persisted in localStorage. Shared across pages via context.
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { api } from "../api";

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  mode: string;
  active: boolean;
  cadenceCaps: Record<string, number>;
  autoApproveFormats: string[];
}

interface CategoryCtx {
  category: string | null; // slug, null = all
  setCategory: (slug: string | null) => void;
  categories: CategoryRow[];
}

const Ctx = createContext<CategoryCtx>({ category: null, setCategory: () => {}, categories: [] });

const STORE_KEY = "ve.category";

export function CategoryProvider({ children }: { children: ReactNode }) {
  const [category, setCategoryState] = useState<string | null>(
    () => localStorage.getItem(STORE_KEY) || null,
  );
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<{ items: CategoryRow[] }>("/categories"),
    staleTime: 60_000,
  });
  const setCategory = (slug: string | null) => {
    if (slug) localStorage.setItem(STORE_KEY, slug);
    else localStorage.removeItem(STORE_KEY);
    setCategoryState(slug);
  };
  return (
    <Ctx.Provider value={{ category, setCategory, categories: cats.data?.items ?? [] }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCategory(): CategoryCtx {
  return useContext(Ctx);
}

export function CategorySelect() {
  const { category, setCategory, categories } = useCategory();
  return (
    <select
      value={category ?? ""}
      onChange={(e) => setCategory(e.target.value || null)}
      className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
    >
      <option value="">All categories</option>
      {categories.map((c) => (
        <option key={c.id} value={c.slug}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** Resolve the selected slug → category id (for id-keyed API filters). */
export function useCategoryId(): string | undefined {
  const { category, categories } = useCategory();
  if (!category) return undefined;
  return categories.find((c) => c.slug === category)?.id;
}
