# Trello MCP Server

MCP (Model Context Protocol) para integração completa com o Trello. Gerencie quadros, listas, cards, labels, checklists, comentários, membros, anexos, webhooks e muito mais diretamente de assistentes de IA como o OpenCode CLI.

## Índice

1. [Instalação](#instalação)
2. [Configuração](#configuração)
3. [Obtendo Credenciais](#obtendo-credenciais-do-trello)
4. [Uso com OpenCode CLI](#uso-com-opencode-cli)
5. [Todas as Funções](#todas-as-funções)
   - [Boards (Quadros)](#boards-quadros)
   - [Listas](#listas)
   - [Cards (Tarefas)](#cards-tarefas)
   - [Labels (Etiquetas)](#labels-etiquetas)
   - [Checklists](#checklists)
   - [Comentários](#comentários)
   - [Datas de Vencimento](#datas-de-vencimento)
   - [Membros](#membros)
   - [Arquivos e Anexos](#arquivos-e-anexos)
   - [Busca](#busca)
   - [Votações](#votações)
   - [Estatísticas](#estatísticas)
   - [Atividades](#atividades)
   - [Power-Ups](#power-ups)
   - [Webhooks](#webhooks)
   - [Automação](#automação)
   - [Export e Templates](#export-e-templates)
6. [Exemplos de Uso](#exemplos-de-uso)
7. [Solução de Problemas](#solução-de-problemas)

---

## Instalação

### Pré-requisitos

- Node.js 18+ instalado
- npm ou yarn
- Conta no Trello

### Passos de Instalação

1. **Clone ou baixe o repositório**

   ```bash
   cd ~/.config/opencode/mcp-servers
   git clone https://github.com/seu-repo/trello-mcp.git
   cd trello-mcp
   ```

2. **Instale as dependências**

   ```bash
   npm install
   ```

3. **Compile o TypeScript**

   ```bash
   npm run build
   ```

4. **Verifique a construção**

   ```bash
   ls dist/
   # Você deve ver: index.js  index.d.ts  index.js.map
   ```

---

## Configuração

### Arquivo de Configuração

Crie o arquivo de configuração em `~/.config/opencode/trello-config.json`:

```json
{
  "apiKey": "SUA_API_KEY_AQUI",
  "token": "SEU_TOKEN_AQUI",
  "boardId": "ID_DO_QUADRO_PADRAO",
  "lists": {
    "backlog": "ID_LISTA_BACKLOG",
    "doing": "ID_LISTA_DOING",
    "testing": "ID_LISTA_TESTING",
    "done": "ID_LISTA_DONE"
  },
  "labels": {
    "pontoFocal": "ID_LABEL"
  }
}
```

### Configuração no OpenCode

Adicione ao seu arquivo `opencode.json`:

```json
{
  "mcp": {
    "trello": {
      "type": "local",
      "command": ["node", "C:/Users/SeuUsuario/.config/opencode/mcp-servers/trello/dist/index.js"],
      "enabled": true
    }
  }
}
```

> **Nota:** No Windows, use o caminho com barras normais.

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
| `trello_get_card` | Obtém detalhes de um card |
| `trello_update_card` | Atualiza um card |
| `trello_delete_card` | Exclui um card |

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
| `trello_mark_due_complete` | Marca vencimento como completo |

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

---

## Exemplos de Uso

### Gerenciamento Básico de Tarefas

```bash
# Listar tarefas do backlog
trello_list_by_list listName="backlog"

# Criar nova tarefa
trello_create_card name="Nova funcionalidade" desc="Descricao da tarefa"

# Ver detalhes de uma tarefa
trello_get_card cardName="Nova funcionalidade"

# Mover tarefa para fazendo
trello_next

# Marcar tarefa como concluida
trello_done
```

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

### Funções não aparecem no OpenCode

1. Reinicie o OpenCode CLI
2. Verifique se o caminho no `opencode.json` está correto
3. Execute `npm run build` novamente

### Debugging

Para verificar se as credenciais estão funcionando:

```bash
trello_list_boards
```

Se retornar uma lista de quadros, as credenciais estão corretas.

---

## Licença

MIT License - Copyright (c) 2026

---

## Contribuição

Sinta-se livre para contribuir com este projeto! Abra issues e mande pull requests.

---

**Desenvolvido com amor para a comunidade OpenCode**
