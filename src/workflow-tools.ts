import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlatformApi } from "./platform-tools.js";
import { selectList, NamedEntity } from "./selection.js";

/** Explicit operations; legacy names remain available without implicit workflow state. */
export function registerWorkflowTools(server: McpServer, api: PlatformApi) {
  const card = { cardId: z.string().trim().min(1).describe("ID do card escolhido") };
  const destination = {
    listId: z.string().trim().min(1).optional().describe("ID da lista escolhida"),
    listName: z.string().trim().min(1).optional().describe("Nome exato da lista escolhida; use ID para nomes repetidos"),
    boardUrl: z.string().trim().min(1).optional().describe("Quadro da lista; padrão: quadro ativo"),
  };
  const run = async (action: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await action(), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Erro Trello" }] }; }
  };
  const target = async (args: { boardUrl?: string; listId?: string; listName?: string }) => {
    const boardId = await api.resolveBoard(args.boardUrl);
    const list = selectList(await api.request<NamedEntity[]>(`/boards/${boardId}/lists`), args.listId, args.listName);
    return { list, boardId };
  };
  for (const name of ["trello_move_card", "trello_next"]) {
    server.tool(name, "Move o card informado para a lista explicitamente escolhida; não seleciona próxima tarefa", { ...card, ...destination },
      async args => run(async () => {
        const { list, boardId } = await target(args);
        return api.request(`/cards/${encodeURIComponent(args.cardId)}`, "PUT", { idList: list.id, idBoard: boardId });
      }));
  }
  for (const name of ["trello_mark_card_complete", "trello_done"]) {
    server.tool(name, "Marca o card informado como concluído ou pendente, sem mover nem comentar; vencimento não é obrigatório", {
      ...card, complete: z.boolean().describe("true conclui; false reabre"),
    }, async ({ cardId, complete }) => run(() => api.request(`/cards/${encodeURIComponent(cardId)}`, "PUT", { dueComplete: complete })));
  }
  server.tool("trello_status", "Consulta o estado atual do card informado", card,
    async ({ cardId }) => run(() => api.request(`/cards/${encodeURIComponent(cardId)}?fields=name,idBoard,idList,due,dueComplete,closed,shortUrl`)));
  server.tool("trello_create", "Cria um card na lista explicitamente escolhida, sem etiquetas automáticas", {
    ...destination, title: z.string().trim().min(1),
  }, async args => run(async () => {
    const { list } = await target(args);
    return api.request("/cards", "POST", { name: args.title, idList: list.id });
  }));
  server.tool("trello_list_pending_backlog_tasks", "Alias legado: lista cards da lista explicitamente informada, sem filtros de etiquetas", destination,
    async args => run(async () => {
      const { list } = await target(args);
      return api.request(`/lists/${list.id}/cards`);
    }));
}
