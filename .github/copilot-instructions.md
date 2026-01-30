# PomodoroTask - Copilot Instructions

Este documento contém padrões, soluções e lições aprendidas durante o desenvolvimento do plugin PomodoroTask para Obsidian.

## ✅ Correção Crítica: Tarefas Recorrentes "when done" NÃO devem ser concluídas

### Contexto do bug

Em tarefas recorrentes com o sufixo **"when done"**, o plugin Tasks **não** conclui a tarefa nem recria nova instância se o clique não tiver efeito (segunda execução). O comportamento correto é: **nenhuma alteração no checkbox**, apenas ajustes internos do Pomodoro, se necessário.

**Problema anterior:** o PomodoroTask concluía a tarefa automaticamente no fim do ciclo, diferente do clique manual do Tasks.

### Solução aplicada (obrigatória)

1. **Detectar recorrência "when done" na linha original**
2. **Tratar como recorrente mesmo quando o Tasks API retorna apenas uma linha**
3. **Nunca fazer fallback de conclusão direta nesses casos**

```typescript
private isWhenDoneRecurringTask(line: string): boolean {
    return /🔁\s*every\s+[^📅⏳🛫✅➕🏁🔺⏫🔽#\[]*\bwhen\s+done\b/iu.test(line);
}

// Em completeTaskViaTasksAPI:
const isWhenDoneRecurring = this.isWhenDoneRecurringTask(originalLine);

// Se Tasks API não altera a linha, mas for when done:
if (result && result === originalLine && isWhenDoneRecurring) return true;

// Nunca completar diretamente no fallback:
if (isWhenDoneRecurring) return true;
```

### Por que isso é obrigatório

O Tasks plugin considera que tarefas recorrentes "when done" **podem não mudar a linha** em execuções subsequentes. Se o PomodoroTask marcar como concluída, ele quebra a compatibilidade com o comportamento esperado pelo usuário.

**Regra:** para "when done", só o Tasks API deve decidir a conclusão. Se não houver mudança, **não concluímos**.


## 🎯 Problema: Esconder Scripts Dataview Até Execução Terminar

### Contexto do Problema

Quando uma tarefa contém scripts Dataview inline (ex: `` `$=dv.func.floor(...)` ``), o código bruto aparece visualmente na tela antes do Dataview processar e renderizar o resultado. Isso polui visualmente a interface.

**Exemplo de tarefa com Dataview:**
```markdown
- [ ] Minha tarefa `$=dv.func.floor((dv.current().file.mtime - dv.date("2025-01-01")) / 86400000)` dias
```

O usuário vê momentaneamente o código `$=dv.func.floor(...)` antes de ver o resultado (ex: "45 dias").

### ❌ Abordagens que NÃO Funcionaram

#### 1. `opacity: 0` com transição CSS
```typescript
// NÃO FUNCIONA
element.style.opacity = '0';
MarkdownRenderer.render(...).then(() => {
    element.style.opacity = '1';
});
```
**Por que falha:** O `MarkdownRenderer.render()` resolve sua Promise ANTES do Dataview executar seu post-processor. O conteúdo ainda mostra código bruto.

#### 2. `visibility: hidden` com polling simples
```typescript
// NÃO FUNCIONA CORRETAMENTE
element.style.visibility = 'hidden';
MarkdownRenderer.render(...).then(() => {
    const checkReady = () => {
        if (!element.querySelector('code')) {
            element.style.visibility = 'visible';
        } else {
            setTimeout(checkReady, 50);
        }
    };
    setTimeout(checkReady, 50);
});
```
**Por que falha:** A verificação `querySelector('code')` não é confiável. O Dataview pode manter elementos `<code>` ou o timing do polling pode não sincronizar corretamente.

#### 3. Remover scripts Dataview do texto
```typescript
// NÃO É O QUE O USUÁRIO QUER
cleanText = cleanText.replace(/`\$=[^`]*`/g, '');
```
**Por que falha:** Remove a funcionalidade. O usuário QUER ver o RESULTADO do script, não escondê-lo completamente.

### ✅ Solução que FUNCIONA

**Estratégia:** Usar `display: none` + `MutationObserver` para detectar quando o Dataview termina de processar.

```typescript
// 1. Esconde completamente o elemento
const textDiv = container.createDiv({ cls: 'my-class' });
textDiv.style.display = 'none';

// 2. Verifica ANTES de renderizar se tem script Dataview
const hasDataviewScript = /`\$=/.test(textContent);

// 3. Renderiza o markdown
MarkdownRenderer.render(app, textContent, textDiv, filePath, component).then(() => {
    
    // 4. Se não tem Dataview, mostra imediatamente (caminho rápido)
    if (!hasDataviewScript) {
        textDiv.style.display = '';
        return;
    }
    
    // 5. Usa MutationObserver para detectar quando Dataview termina
    const observer = new MutationObserver(() => {
        const text = textDiv.textContent || '';
        // Verifica se ainda tem marcadores de código bruto
        const stillHasRawCode = text.includes('$=') || text.includes('dv.');
        
        if (!stillHasRawCode) {
            textDiv.style.display = '';
            observer.disconnect();
        }
    });
    
    // Observa mudanças no DOM (Dataview modifica childList)
    observer.observe(textDiv, { 
        childList: true, 
        subtree: true, 
        characterData: true 
    });
    
    // 6. Fallback timeout - mostra após 3 segundos mesmo se algo falhar
    setTimeout(() => {
        textDiv.style.display = '';
        observer.disconnect();
    }, 3000);
});
```

### Por que esta solução funciona

1. **`display: none`** - Esconde completamente o elemento, não ocupa espaço, não é visível de forma alguma

2. **Detecção prévia** - `/`\$=/.test(text)` verifica se a tarefa TEM script Dataview ANTES de renderizar. Isso permite um "caminho rápido" para tarefas normais (sem espera)

3. **MutationObserver** - O Dataview opera como post-processor que modifica o DOM DEPOIS que `MarkdownRenderer.render()` resolve. O MutationObserver detecta essas mudanças

4. **Verificação de texto** - Procura por `$=` e `dv.` no `textContent`. Quando o Dataview processa, ele substitui o código pelo resultado, removendo esses marcadores

5. **Fallback de 3 segundos** - Garante que mesmo se o Dataview falhar ou demorar muito, o conteúdo será mostrado eventualmente

### Locais onde esta solução foi aplicada

- `renderTaskList()` - Lista de tarefas principal (cleanSpan e fullSpan)
- `renderTimer()` - Tarefa ativa no timer
- `renderSubtasks()` - Subtarefas abaixo da tarefa ativa

---

## 📋 Padrões de Código do Projeto

### Component Lifecycle (MarkdownRenderer)

Sempre use o padrão `addChild`/`removeChild` para gerenciar componentes do MarkdownRenderer:

```typescript
// Criar
const comp = new Component();
this.addChild(comp);
this.markdownComponents.push(comp);

// Limpar (em clearMarkdownComponents)
for (const comp of this.markdownComponents) {
    this.removeChild(comp);
    comp.unload();
}
this.markdownComponents = [];
```

### Limpeza de Texto de Tarefas

O `cleanTaskText()` preserva code blocks usando placeholders:

```typescript
// 1. Substitui code blocks por placeholders
const codeBlocks: string[] = [];
text = text.replace(/`[^`]+`/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
});

// 2. Faz limpeza (remove tags, metadados, etc.)
// ...

// 3. Restaura code blocks
codeBlocks.forEach((block, i) => {
    text = text.replace(`__CODE_BLOCK_${i}__`, block);
});
```

---

## 🔗 Referências

- **Dataview Plugin:** Opera como post-processor do Obsidian, executa DEPOIS do MarkdownRenderer
- **Task-Board Plugin:** Usa abordagem similar com CSS fade-in e async rendering
- **Obsidian API:** `MarkdownRenderer.render()` retorna Promise que resolve antes de post-processors

---

*Última atualização: Janeiro 2026*
