# netcluster sobre Redis — Node.js sem estado

O índice inteiro (a hierarquia de nets) vive no Redis. Os processos Node não
guardam nada entre requisições: suba N pods atrás de um load balancer, mate
qualquer um a qualquer momento.

```
   pods Node (sem estado)                    Redis (primário)
  ┌───────────────────┐   EVALSHA  ┌──────────────────────────────┐
  │ POST /devices/:id ├───────────▶│ upsert.lua ─┐                │
  │ DELETE /devices   │            │ remove.lua ─┼─ atômico       │
  └───────────────────┘            │             │  (1 script =   │
  ┌───────────────────┐            │             │   1 unidade de │
  │ GET /tile/z/x/y   ├──EVALSHA_RO┤ query.lua ◀─┘   consistência)│
  │ GET /clusters     │      │     └──────────────┬───────────────┘
  └───────────────────┘      │                    │ replicação
                             └────────────────────▼────────────
                                              Redis (réplica)
```

## Por que Lua, e não comandos soltos

Os invariantes da estrutura cruzam várias chaves. Dois pods movendo dispositivos
na mesma vizinhança leriam ambos "nenhum centro dentro de r_z", ambos se
promoveriam a centro, e a separação estaria quebrada **para sempre** — a
estrutura não tem passo de rebuild para consertar isso depois. O Redis executa
script por script, então o script é a unidade de consistência aqui. Não há como
fazer isso com MULTI/WATCH sem contenção proibitiva.

Isso está testado, não presumido: `test/redis-integration.js` sobe 8 clientes
concorrentes gravando ao mesmo tempo e depois verifica todos os invariantes lendo
o estado de volta do Redis.

## Começando

```bash
redis-server --port 6379 &
REDIS_URL=redis://127.0.0.1:6379 node server/server.js

curl -X POST localhost:3000/devices -H 'content-type: application/json' \
  -d '[{"id":"v1","lng":-46.63,"lat":-23.55},{"id":"v2","lng":-46.64,"lat":-23.56}]'
curl 'localhost:3000/tile/11/758/1161'
```

## API

| | |
|---|---|
| `POST /devices/:id` `{lng, lat}` | reporta posição — inserir e mover são a mesma chamada |
| `POST /devices` `[{id, lng, lat}]` | lote (até 10.000), enviado como um pipeline |
| `DELETE /devices/:id` | remove |
| `GET /tile/:z/:x/:y` | clusters de um tile — **prefira este**, a chave é estável e o cache funciona |
| `GET /clusters?bbox=o,s,l,n&zoom=z` | clusters de um bbox arbitrário (não cacheável na prática) |
| `GET /devices/:id/cluster?zoom=z` | em qual marcador este dispositivo está desenhado |
| `GET /health` · `GET /stats` | `/stats` faz SCAN do keyspace: só para depuração |

A saída é GeoJSON com o mesmo formato do `supercluster`, então o frontend não muda.

## Configuração

| variável | padrão | |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | primário (escrita) |
| `REDIS_READ_URL` | — | réplica opcional; consultas vão para lá via `EVALSHA_RO` |
| `TILE_TTL_MS` | `0` | cache de tiles no Redis; `1000` é um bom valor para mapa ao vivo |
| `NC_RADIUS` / `NC_MAXZOOM` / `NC_HYSTERESIS` | 40 / 16 / 0.25 | geometria |
| `NC_PREFIX` | `nc` | prefixo das chaves |

A geometria é publicada em `nc:cfg` na primeira subida. Um pod que suba com
`NC_RADIUS` diferente **falha na inicialização** em vez de corromper o índice.

## Números medidos (Redis local, sem persistência, N=100.000)

| | Redis | no processo |
|---|---|---|
| mover 1 ponto, sequencial | 151,6 µs | 1,49 µs |
| mover 1 ponto, pipeline de 100 | **64,1 µs** | — |
| taxa de escrita sustentada | **~16.000 mov/s** | 671.000 mov/s |
| consulta z10 (153 clusters) | 3,17 ms (1,51 ms na réplica) | 0,021 ms |
| consulta z14 (4.325 clusters) | 21,7 ms | 0,245 ms |
| carga inicial de 100k | 4,9 s | 179 ms |

### O teto, e ele é real

**~16.000 movimentos/s por primário Redis, e mais conexões não ajudam.** Medido:
1 conexão dá 16.297 mov/s, 16 conexões dão 16.961. O gargalo é a CPU única do
Redis executando os scripts, não a rede — é por isso que o pipeline ajuda
(7.600 → 15.600 mov/s) e o paralelismo não.

Dimensione por aí: 16k mov/s comporta ~1 milhão de dispositivos reportando a
cada 60 s, ou ~160.000 reportando a cada 10 s. Acima disso, as opções são as
duas do relatório principal: um indexador único em memória (671k mov/s), ou
particionar por região com um Redis por partição.

### Sim, isso bloqueia o Redis. Quanto, exatamente

O Redis é single-threaded: enquanto um script roda, ninguém mais é atendido.
Medido com `INFO commandstats`, que reporta o tempo *dentro* do servidor:

| | 10k pontos | 100k | 1M |
|---|---|---|---|
| `upsert` (1 movimento) | 51 µs | 62 µs | **106 µs** |
| consulta z8 | 0,8 ms | 1,3 ms | 1,6 ms |
| consulta z10 | 2,0 ms | 3,0 ms | 3,6 ms |
| consulta z14 | 3,5 ms | 19,8 ms | **20,2 ms** |

Escrita bloqueia por ~100 µs, o que é aceitável. Consulta larga bloqueia por
20 ms, o que não é.

### O tamanho do lote É a janela de bloqueio

O Redis termina um pipeline inteiro antes de atender qualquer outro cliente.
Então o lote não é só uma alavanca de throughput — ele é exatamente o atraso que
todo mundo sente. Com 200.000 pontos, medindo um `GET` trivial de outro cliente:

| lote | movimentos/s | p50 de outro cliente | p99 de outro cliente |
|---|---|---|---|
| 1 | 5.160 | 174 µs | 667 µs |
| 5 | 11.064 | 430 µs | 858 µs |
| **20** | **15.470** | **1,3 ms** | **1,7 ms** |
| 50 | 17.485 | 2,8 ms | 3,3 ms |
| 200 | 18.816 | 7,6 ms | 11,1 ms |

Lote 20 entrega 82% do throughput de pico com um sétimo do bloqueio. Por isso o
cliente fatia internamente em `maxPipeline` (padrão 25) — mande 5.000 pontos de
uma vez se quiser, que ele divide sozinho. `NC_MAX_PIPELINE` ajusta.

### Consultas largas bloqueiam o Redis

Uma consulta z14 devolvendo 4.325 clusters ocupa o Redis por 21 ms — e o Redis é
single-threaded, então **todos os outros clientes esperam esses 21 ms**. Duas
defesas, use as duas:

1. `REDIS_READ_URL` aponta as consultas para uma réplica via `EVALSHA_RO`. O
   Redis rejeita escritas nesses scripts, então o caminho de leitura é
   verificadamente incapaz de escrever, e o primário não paga nada pelas
   leituras. Isso foi medido, com consultas z14 em loop e um `GET` trivial
   cronometrado no primário:

   | consultas vão para | p50 no primário | p99 no primário |
   |---|---|---|
   | o primário | 18,6 ms | 28,1 ms |
   | **a réplica** | **61 µs** | **89 µs** |

   61 µs é exatamente a latência do Redis ocioso. A réplica não reduz o
   bloqueio: ela o remove do primário.
2. `TILE_TTL_MS=1000` com `/tile/:z/:x/:y`. Não use o cache com `/clusters`: o
   bbox muda a cada pixel de pan e a taxa de acerto é praticamente zero.

## Um primário só, sem Redis Cluster

Os scripts tocam chaves derivadas da geometria (células de grade em vários
níveis, cadeia de ancestrais). Essas chaves não podem ser co-localizadas atrás de
uma hash tag, então o Cluster rejeitaria os scripts. Réplicas para leitura são
suportadas e recomendadas. Para escalar escrita além de um primário, particione
por região (um índice por área, mais um índice global pequeno agregando os
centros grossos de cada partição) — o desenho está no relatório principal.

## Testes

```bash
redis-server --port 6399 --save '' --appendonly no --daemonize yes
npm run test:redis     # diferencial vs em processo + concorrência + morte de pod
npm run bench:redis    # a tabela de números acima
```

`test/redis-integration.js` verifica três coisas:

1. **Equivalência exata.** A mesma sequência de operações roda na implementação
   em processo e na do Redis; a partição induzida em *todos* os zooms tem que ser
   idêntica, dispositivo por dispositivo, além da saída de `getClusters`.
2. **Concorrência.** 8 clientes gravando ao mesmo tempo; depois os invariantes
   são conferidos lendo o estado do Redis (separação par a par, cobertura,
   agregados contra soma explícita de subárvore, consistência da grade).
3. **Morte de pod.** Uma conexão é derrubada no meio de 60 escritas em voo; o
   índice tem que continuar consistente.
