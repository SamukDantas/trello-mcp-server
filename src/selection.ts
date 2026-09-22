export interface NamedEntity { id: string; name: string }

export function selectList<T extends NamedEntity>(lists: T[], listId?: string, listName?: string): T {
  if (!listId && !listName?.trim()) throw new Error("Informe listId ou o nome exato em listName");
  const name = listName?.trim().toLowerCase();
  const matches = lists.filter(list => (!listId || list.id === listId) &&
    (name === undefined || list.name.trim().toLowerCase() === name));
  if (matches.length === 0) throw new Error("Lista não encontrada no quadro ou ID e nome incompatíveis");
  if (matches.length > 1) throw new Error("Nome de lista ambíguo; informe listId");
  return matches[0];
}
