# Trello MCP Server

Servidor [MCP (Model Context Protocol)](https://modelcontextprotocol.io) para integração completa com o Trello. Gerencie quadros, listas, cards, labels, checklists, comentários, membros, anexos, campos personalizados, webhooks e automações diretamente de assistentes de IA: **Claude Code, Claude Desktop, OpenCode** ou qualquer cliente MCP via stdio.

- **79 ferramentas**, cobrindo boards, listas, cards, labels, checklists, datas, membros, anexos, busca, votos, estatísticas, atividades, power-ups, webhooks, automação e campos personalizados
- **96 testes automatizados** com clientes MCP em memória e via stdio, com respostas do Trello simuladas (sem credenciais nem quadros reais)
- TypeScript estrito, SDK oficial do MCP e validação de parâmetros com Zod

## Índice

1. [Instalação](#instalação)
2. [Configuração](#configuração)
3. [Obtendo Credenciais](#obtendo-credenciais-do-trello)
4. [Uso nos clientes MCP](#uso-nos-clientes-mcp)
5. [Todas as Funções](#todas-as-funções)
6. [Exemplos de Uso](#exemplos-de-uso)
7. [Solução de Problemas](#solução-de-problemas)
8. [Desenvolvimento e validação](#desenvolvimento-e-validação)

---

## Instalação

### Pré-requisitos

- Node.js 18+ e npm
- Conta no Trello

### Passos

```bash
git clone https://github.com/SamukDantas/trello-mcp-server.git
cd trello-mcp-server
npm install
npm run build
```

O build gera `dist/index.js`, que é o ponto de entrada do servidor.

---

## Configuração

O servidor lê as credenciais de `~/.config/opencode/trello-config.json` (no Windows, `C:/Users/<você>/.config/opencode/trello-config.json`), qualquer que seja o cliente MCP:

```json
{
  "apiKey": "SUA_API_KEY_AQUI",
  "token": "SEU_TOKEN_AQUI",
  "boardId": "ID_DO_QUADRO_PADRAO"
}
```

As propriedades antigas `lists` e `labels` não são utilizadas. Nenhum nome de
coluna, ordem de listas ou etiqueta determina o fluxo. O `boardId` define somente
o quadro padrão; `boardUrl` e `trello_set_board` permitem escolher outro quadro.

> Este arquivo contém credenciais: não o versione. O `.gitignore` do projeto já ignora `*-config.json`.

---

## Obtendo Credenciais do Trello

### Passo 1: Obter a API Key

1. Acesse: https://trello.com/app-key
2. Faça login na sua conta Trello
3. Copie a "API Key" mostrada na página

### Passo 2: Obter o Token de Acesso

**Opção 1: Gerar token permanente (Recomendado)**

Substitua `SUA_API_KEY` pela chave obtida no passo anterior e visite:

```
https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=OpenCode-MCP&key=SUA_API_KEY
```

**Opção 2: Usar Trello Power-Up**
1. Acesse: https://trello.com/power-ups/admin
2. Crie um novo Power-Up (ou use um existente)
3. Na seção "OAuth", configure como "Default"
4. Generate token

### Passo 3: Obter o Board ID

1. Abra seu quadro no Trello
2. A URL será: `https://trello.com/b/ABCD1234/nome-do-quadro`
3. O Board ID é `ABCD1234` (código após `/b/`)

### Passo 4: Obter List IDs

Use o OpenCode para executar:
```bash
trello_list_lists
```

Isso irá mostrar todas as listas e seus IDs.

---

## Uso nos clientes MCP

Nos exemplos, troque `/caminho/para` pelo diretório onde você clonou o repositório. No Windows, use barras normais (`C:/Users/...`).

### Claude Code

```bash
claude mcp add trello -- node /caminho/para/trello-mcp-server/dist/index.js
```

### Claude Desktop

Em `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trello": {
      "command": "node",
      "args": ["/caminho/para/trello-mcp-server/dist/index.js"]
    }
  }
}
```

### OpenCode

Em `opencode.json`:

```json
{
  "mcp": {
    "trello": {
      "type": "local",
      "command": ["node", "/caminho/para/trello-mcp-server/dist/index.js"],
      "enabled": true
    }
  }
}
```

Depois de configurar, reinicie o cliente. Para validar as credenciais, peça ao assistente para executar `trello_list_boards`: se ele listar seus quadros, está tudo certo.

---

## Todas as Funções

### Boards (Quadros)

| Função | Descrição |
|--------|------------|
| `trello_list_boards` | Lista todos os quadros do usuário |
| `trello_set_board` | Define o quadro ativo para operações |
| `trello_create_board` | Cria um novo quadro |
| `trello_update_board` | Atualiza um quadro existente |
| `trello_delete_board` | Exclui um quadro |

### Listas

| Função | Descrição |
|--------|------------|
| `trello_list_lists` | Lista todas as listas do quadro |
| `trello_list_cards_in_list` | Lista cards de uma lista específica |
| `trello_create_list` | Cria uma nova lista |
| `trello_update_list` | Atualiza uma lista |
| `trello_delete_list` | Exclui uma lista |

### Cards (Tarefas)

| Função | Descrição |
|--------|------------|
| `trello_create_card` | Cria um novo card |
| `trello_get_card_details` | Obtém detalhes e descrição completa do card, sem truncamento |
| `trello_update_card` | Atualiza um card; movimentação exige listId ou listName exato |
| `trello_move_card` | Move um card para a lista escolhida explicitamente |
| `trello_mark_card_complete` | Conclui ou reabre um card, sem movimentação |
| `trello_delete_card` | Exclui um card |

Para ler a descrição de um card, use `trello_get_card_details` com `cardId` ou `cardName`. A resposta inclui todo o texto, preservando Markdown e quebras de linha; descrições vazias são identificadas explicitamente. Não é necessário abrir o navegador para obter o restante da descrição. A confirmação de `trello_create_card` também inclui a descrição integral.

Após atualizar o código, execute `npm run build` e reinicie a conexão MCP no cliente para carregar a nova versão.

### Labels (Etiquetas)

| Função | Descrição |
|--------|------------|
| `trello_list_labels` | Lista todas as labels do quadro |
| `trello_create_label` | Cria uma nova label |
| `trello_update_label` | Atualiza uma label |
| `trello_delete_label` | Exclui uma label |

### Checklists

| Função | Descrição |
|--------|------------|
| `trello_create_checklist` | Cria um checklist em um card |
| `trello_get_checklists` | Lista checklists de um card |
| `trello_update_checklist` | Atualiza um checklist |
| `trello_delete_checklist` | Exclui um checklist |
| `trello_add_checklist_item` | Adiciona item ao checklist |
| `trello_update_checklist_item` | Atualiza item do checklist |
| `trello_delete_checklist_item` | Remove item do checklist |

### Comentários

| Função | Descrição |
|--------|------------|
| `trello_add_comment` | Adiciona comentário a um card |
| `trello_get_comments` | Lista comentários de um card |
| `trello_update_comment` | Atualiza um comentário |
| `trello_delete_comment` | Exclui um comentário |

### Datas de Vencimento

| Função | Descrição |
|--------|------------|
| `trello_set_due_date` | Define data de vencimento |
| `trello_get_due_date` | Obtém data de vencimento |
| `trello_remove_due_date` | Remove data de vencimento |
| `trello_mark_due_complete` | Marca o card como concluído ou pendente, inclusive sem vencimento |

### Membros

| Função | Descrição |
|--------|------------|
| `trello_list_board_members` | Lista membros do quadro |
| `trello_add_board_member` | Adiciona membro ao quadro |
| `trello_remove_board_member` | Remove membro do quadro |
| `trello_list_card_members` | Lista membros de um card |
| `trello_add_card_member` | Adiciona membro ao card |
| `trello_remove_card_member` | Remove membro do card |

### Arquivos e Anexos

| Função | Descrição |
|--------|------------|
| `trello_list_attachments` | Lista anexos de um card |
| `trello_upload_attachment` | Faz upload de anexo via URL |
| `trello_download_attachment` | Obtém URL de download |
| `trello_delete_attachment` | Remove anexo |

### Busca

| Função | Descrição |
|--------|------------|
| `trello_search_cards` | Busca cards por termo |
| `trello_search_by_label` | Busca cards por label |
| `trello_search_by_due` | Busca cards por data de vencimento |
| `trello_search_in_board` | Pesquisa avançada no quadro |

### Votações

| Função | Descrição |
|--------|------------|
| `trello_vote_card` | Vota em um card |
| `trello_unvote_card` | Remove voto de um card |
| `trello_list_card_votes` | Lista votos de um card |

### Estatísticas

| Função | Descrição |
|--------|------------|
| `trello_board_stats` | Estatísticas gerais do quadro |
| `trello_board_activity_stats` | Estatísticas de atividade |

### Atividades

| Função | Descrição |
|--------|------------|
| `trello_get_card_activities` | Atividades de um card |
| `trello_get_board_actions` | Ações recentes do quadro |

### Power-Ups

| Função | Descrição |
|--------|------------|
| `trello_list_power_ups` | Lista Power-Ups do quadro |
| `trello_enable_power_up` | Ativa Power-Up |
| `trello_disable_power_up` | Desativa Power-Up |

### Webhooks

| Função | Descrição |
|--------|------------|
| `trello_list_webhooks` | Lista webhooks do usuário |
| `trello_create_webhook` | Cria um webhook |
| `trello_delete_webhook` | Exclui um webhook |

### Automação

| Função | Descrição |
|--------|------------|
| `trello_create_automation` | Cria automação (Butler) |

### Export e Templates

| Função | Descrição |
|--------|------------|
| `trello_export_board` | Exporta quadro para JSON |
| `trello_create_from_template` | Cria quadro a partir de template |

### Recursos nativos adicionais

As extensões abaixo usam a API REST oficial e ficam em `src/platform-tools.ts`.
Foram priorizadas por cobrir lacunas do MCP: dados estruturados nos cards,
recuperação de cards arquivados e acompanhamento individual.

| Ferramenta | Uso |
|-----------|-----|
| `trello_list_custom_fields` | Lista campos do quadro com tipos e IDs das opções |
| `trello_create_custom_field` | Cria campo text, number, date, checkbox ou list |
| `trello_get_card_custom_fields` | Lê valores com nomes dos campos e opções |
| `trello_set_card_custom_field` | Preenche ou limpa um campo do card |
| `trello_list_archived_cards` | Lista cards arquivados com seus IDs |
| `trello_set_card_archived` | Arquiva (`true`) ou restaura (`false`) um card |
| `trello_set_card_subscription` | Acompanha ou deixa de acompanhar um card |

As ferramentas de quadro aceitam `boardUrl` (URL, ID ou nome); quando omitido,
usam o quadro ativo ou o padrão da configuração. As ferramentas de card exigem
`cardId` de 24 caracteres, retornado pelas listagens, e operam diretamente nesse
card, independentemente do quadro ativo. Não aceitam nomes parciais.

Exemplos de chamadas MCP (nome da ferramenta seguido dos argumentos JSON):

```text
trello_create_custom_field {"name":"Prioridade","type":"list","options":["Alta","Média","Baixa"]}
trello_list_custom_fields {}
trello_set_card_custom_field {"cardId":"ID_DO_CARD","customFieldId":"ID_DO_CAMPO","value":"ID_DA_OPCAO"}
trello_get_card_custom_fields {"cardId":"ID_DO_CARD"}
trello_set_card_custom_field {"cardId":"ID_DO_CARD","customFieldId":"ID_DO_CAMPO","value":null}
trello_list_archived_cards {}
trello_set_card_archived {"cardId":"ID_DO_CARD","archived":false}
trello_set_card_subscription {"cardId":"ID_DO_CARD","subscribed":true}
```

Substitua os IDs ilustrativos por IDs reais. Campos number recebem número JSON;
checkbox recebe booleano; date recebe ISO 8601 com fuso (por exemplo,
`2026-09-22T08:00:00-04:00`); list recebe o ID de uma opção existente.
`null` limpa qualquer tipo de campo. A criação de campos list exige opções únicas;
outros tipos não aceitam opções. O campo deve pertencer ao quadro do card.

Campos personalizados dependem da disponibilidade do recurso e das permissões
no quadro do Trello. As ferramentas retornam falhas com `isError: true`.
Restaurar um card preserva sua lista original; se a lista estiver arquivada, ela
precisa ser reaberta no Trello para voltar a aparecer no quadro. Acompanhar afeta
somente o usuário autenticado e segue as regras de notificações do Trello.

Referências oficiais:
- [Campos personalizados](https://developer.atlassian.com/cloud/trello/guides/rest-api/getting-started-with-custom-fields/)
- [API de campos personalizados](https://developer.atlassian.com/cloud/trello/rest/api-group-customfields/)
- [API de cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/)

---

## Exemplos de Uso

### Gerenciamento de Cards

Exemplos de chamadas MCP (não são comandos de terminal). Substitua os IDs pelos
valores retornados nas listagens:

```text
trello_list_lists {}
trello_list_cards_in_list {"listName":"Triagem"}
trello_create_card {"name":"Novo pedido","listName":"Triagem","desc":"Descrição do pedido"}
trello_move_card {"cardId":"ID_DO_CARD","listName":"Análise comercial"}
trello_move_card {"cardId":"ID_DO_CARD","listId":"ID_DA_LISTA","boardUrl":"Quadro de destino"}
trello_mark_card_complete {"cardId":"ID_DO_CARD","complete":true}
trello_mark_card_complete {"cardId":"ID_DO_CARD","complete":false}
```

Listas são selecionadas por ID ou nome exato (ignorando maiúsculas e espaços nas
extremidades). Nomes repetidos exigem ID; informar ID e nome incompatíveis gera
erro. Criação exige uma lista. Atualização só move quando `listId` ou `listName`
é informado. A lista deve pertencer ao quadro selecionado. Para mover para outro
quadro, selecione esse quadro como destino com `boardUrl` ou como ativo.
Concluir altera apenas `dueComplete`, sem mover, comentar ou arquivar.

### Migração dos atalhos antigos

Os nomes legados continuam disponíveis, mas seus parâmetros mudaram. Chamadas
sem card ou lista não escolhem mais uma tarefa ou coluna automaticamente.

| Atalho | Parâmetros e comportamento atual |
|--------|---------------------------------|
| `trello_next` | `cardId` e `listId` ou `listName`; equivale a mover o card escolhido |
| `trello_done` | `cardId` e `complete`; equivale a concluir/reabrir, sem movimentar |
| `trello_status` | `cardId`; consulta o estado do card na API |
| `trello_create` | `title` e `listId` ou `listName`; cria sem etiquetas automáticas |
| `trello_list_pending_backlog_tasks` | `listId` ou `listName`; lista cards dessa lista, sem filtro de etiqueta |

`trello_create_card`, `trello_list_cards_in_list`, `trello_update_list` e
`trello_delete_list` também aceitam ID ou nome exato de lista.
`trello_update_card` aceita nome exato do card ou ID; nomes de cards repetidos
exigem ID. Nas operações em lote `trello_archive_all_cards` e
`trello_delete_all_cards`, omitir ambos os filtros de lista opera no quadro
inteiro; `confirm: true` continua obrigatório. Um filtro inválido gera erro.

### Trabalhando com Membros

```bash
# Listar membros do quadro
trello_list_board_members

# Adicionar membro a um card
trello_add_card_member cardName="Tarefa" memberId="id_do_membro"
```

### Busca e Organização

```bash
# Buscar cards por termo
trello_search_cards query="bug"

# Buscar cards por label
trello_search_by_label labelName="Urgente"

# Buscar cards atrasados
trello_search_by_due overdue=true
```

### Estatísticas

```bash
# Ver estatisticas do quadro
trello_board_stats

# Ver estatisticas de atividade
trello_board_activity_stats days=30
```

### Arquivos

```bash
# Listar anexos de um card
trello_list_attachments cardName="Projeto X"

# Fazer upload de arquivo
trello_upload_attachment cardName="Projeto X" fileUrl="https://exemplo.com/arquivo.pdf"
```

### Webhooks

```bash
# Criar webhook para notifications
trello_create_webhook callbackURL="https://meusite.com/webhook" modelId="id_do_board"

# Listar webhooks existentes
trello_list_webhooks
```

### Export

```bash
# Exportar quadro
trello_export_board

# Criar quadro a partir de template
trello_create_from_template name="Novo Projeto" templateId="id_do_template"
```

---

## Solução de Problemas

### Erro: "fetch failed" / falha HTTPS

O MCP inclui automaticamente os certificados confiáveis do sistema junto das CAs padrão do Node.js quando o runtime oferece `tls.getCACertificates` e `tls.setDefaultCACertificates`. Isso permite usar redes com uma CA local confiável sem desativar a validação HTTPS. Recomendamos Node.js 24 LTS para esse suporte.

Em runtimes antigos, atualize o Node.js ou configure `NODE_EXTRA_CA_CERTS` com o caminho de um arquivo PEM contendo a CA confiável da sua rede antes de iniciar o MCP. Reinicie a conexão MCP após atualizar.

Falhas de rede agora informam o código da causa (por exemplo, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` ou `ENOTFOUND`), sem expor a API key ou o token. Erros de certificado expirado ou hostname incorreto exigem corrigir o certificado.

### Erro: "API Key inválida"

- Verifique se a API Key está correta no arquivo de configuração
- Certifique-se de que gerou o token com permissões `read,write`

### Erro: "Token expirado"

- Gere um novo token usando o link com `expiration=never`
- Atualize o arquivo de configuração

### Erro: "Board não encontrado"

- Verifique se o Board ID está correto
- Use `trello_list_boards` para ver todos os quadros disponíveis

### Erro: "Card não encontrado"

- Tente usar o parâmetro `cardId` em vez de `cardName`
- Verifique se o card está no quadro correto

### Funções não aparecem no cliente MCP

1. Reinicie o cliente MCP
2. Verifique se o caminho para `dist/index.js` na configuração do cliente está correto
3. Execute `npm run build` novamente

### Debugging

Para verificar se as credenciais estão funcionando:

```bash
trello_list_boards
```

Se retornar uma lista de quadros, as credenciais estão corretas.

---

## Desenvolvimento e validação

```bash
npm run build
npm test
```

Os testes usam clientes MCP em memória e via stdio, com respostas Trello simuladas.
Não precisam de credenciais nem acessam quadros reais. Após compilar, reinicie o
cliente MCP para carregar as novas ferramentas. O servidor expõe 79 ferramentas.

---

## Licença

[MIT](LICENSE) © 2026 Samuel Dantas

## Contribuição

Issues e pull requests são bem-vindos.
