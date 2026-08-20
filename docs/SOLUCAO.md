# Resposta ao brief — clustering geoespacial incremental

**Relatório completo, com demo ao vivo:** https://claude.ai/code/artifact/288f3873-262b-489d-a46e-13148b32e4ec

O `README.md` (o brief) fica intocado. Este arquivo é a resposta.

---

## Resumo

As três propriedades do brief **são simultaneamente satisfazíveis**. A suspeita da
"nota de honestidade" — de que haveria tensão fundamental entre elas — não se
sustenta. O que existe é uma lacuna de biblioteca.

A estrutura que resolve as três é uma **hierarquia de nets** (*discrete center
hierarchy* / *net-tree* / *cover tree*) sobre uma métrica *doubling*. O plano de
Web Mercator é uma métrica doubling, e os níveis de zoom de um mapa já são a
escada de escalas `r, r/2, r/4, …` em que essa hierarquia é definida.

A virada conceitual: um mapa nunca pediu **k clusters** (formulação genuinamente
difícil no regime dinâmico), e sim **clusters de raio fixo por nível de zoom**
(formulação fácil: mantida por regras locais, porque no plano cabem só `O(1)`
pontos `r`-separados em qualquer bola de raio `2r`).

Resultado teórico central: Gao–Guibas–Nguyen (SoCG 2004) e Schmidt–Sohler (2019).
Os invariantes do Lema 3.1 do primeiro são, item por item, os implementados aqui.

## O que foi construído

`netcluster` — implementação de referência, JavaScript, zero dependências,
API de leitura compatível com `supercluster`, mas com escrita:

```js
index.insert(id, lng, lat, props);  // ~2 µs
index.moveTo(id, lng, lat);         // ~2 µs   <- a operação que faltava
index.remove(id);                   // ~7,6 µs
index.getClusters(bbox, zoom);      // O(K), independente de N
```

### Invariantes mantidos (para todo zoom z, a todo instante)

1. **Aninhamento** `C₀ ⊆ C₁ ⊆ … ⊆ C_maxZoom ⊆ P`
2. **Separação** dois centros de `C_z` distam mais de `r_z`
3. **Cobertura** todo membro de `C_{z+1}\C_z` tem pai em `C_z` a distância ≤ `r_z`

Donde: raio de cluster ≤ `2·r_z` e nº de clusters ≤ o de uma solução ótima com
metade do raio — garantia bicritério de `r`-nets, válida sempre, sem rebuild.

## Medições (todas reproduzíveis com `npm run bench`)

| | netcluster | supercluster |
|---|---|---|
| mover 1 ponto (N=500k) | **2,09 µs** | 877 ms (reload completo) |
| inserir / remover | 2,07 µs / 7,8 µs | idem |
| build (N=100k) | 177 ms | 182 ms |
| consulta viewport z10 (N=1M) | 0,023 ms | 0,021 ms |
| memória (N=500k) | **119 MB** | 289 MB |

- **Qualidade**: contagem de clusters e raio dentro de ~1% do supercluster em
  todos os zooms. Grade fixa, no mesmo teste: 43% mais marcadores e 15–23% dos
  vizinhos próximos separados por borda de célula.
- **Estabilidade**: após 5.000.000 de movimentos sem rebuild, a qualidade fica a
  1,2% de um índice recém-construído — e *estabiliza*, não degrada. Throughput
  plano do primeiro ao último ciclo. 0,027 troca de cluster por movimento.
- **Hora do rush** (40% da frota convergindo para 20 locais): guloso incremental
  acumula 19% mais marcadores, 8,2% deles desenhados por cima de outro; o
  netcluster fica a 1,1% do rebuild, sem nenhuma colisão.
- **Densidade local D**: o custo não tem termo em D. Com N fixo em 200.000 e D
  variando 10⁶× (de 0 a 1.975 pontos por bola de 48 m), mover 1 ponto vai de
  2,14 µs para **0,52 µs** — fica mais *barato* com densidade, porque em área
  densa quase todo ponto é folha e folha não tem restrição de separação a
  verificar. Compare com `O(D log N)` da abordagem "dirty region" avaliada no
  brief, que degrada justamente no centro da cidade em hora de pico.

## Limites conhecidos

- Raio **máximo** pior que o de um rebuild sob convergência forte (94,6 px vs
  64,7 px; limite provado `2(1+h)·r` = 100 px). Ajustável por `hysteresis`.
- Remoção é 3,6× mais cara que inserção (cascata de re-hospedagem).
- Memória O(N) com constante ~4,2 listagens de grade por ponto (119 MB para 500k).
- Código novo: tem verificação exaustiva de invariantes, não tem anos de produção.

## Arquivos

```
src/netcluster.js        estrutura (hierarquia de nets + agregados em ponto fixo)
src/cellhash.js          hash de células em typed arrays, remoção por backward shift
test/invariants.js       verificador por força bruta: separação par a par, cobertura,
                         agregados vs soma explícita de subárvore, consistência da
                         grade, partição e limite de raio em todos os níveis
test/api.js              partição, zoom de expansão, filhos, folhas, viewport
test/demo-headless.js    roda a demo publicada contra um DOM mínimo
bench/                   os seis experimentos do relatório
docs/report.html         o relatório publicado (gerado por `npm run build`)
docs/bench/              saída bruta dos benchmarks
```

## Deploy com Redis + Node sem estado

Ver `server/README.md`. O índice inteiro vive no Redis, os pods Node não guardam
nada, e as mutações rodam como scripts Lua porque os invariantes cruzam chaves.
Medido: ~16.000 movimentos/s por primário Redis (contra 671.000/s em processo),
consultas servidas de réplica via `EVALSHA_RO`.

```
src/            índice em processo (671k mov/s)
server/         índice no Redis + API HTTP sem estado (~16k mov/s)
server/lua/     as operações, atômicas
```

`npm test` · `npm run bench` · `npm run build` · `npm run test:redis` · `npm run bench:redis`
