[200~# Brief de pesquisa: clustering geoespacial incremental de alta qualidade



## Contexto



Sistema de localização em tempo real: N dispositivos móveis atualizam posição

continuamente. É necessário exibir esses dispositivos agrupados (clustering)

em um mapa, com granularidade dependente do zoom, para não sobrecarregar o

frontend com milhares de marcadores individuais.



## Problema



Buscamos um algoritmo/estrutura de dados de clustering espacial que satisfaça

simultaneamente três propriedades:



1. **Atualização incremental eficiente** — mover 1 ponto deve custar

   sensivelmente menos que O(N log N); idealmente O(log N) ou melhor,

   independente do total de pontos N no sistema.

2. **Qualidade de agrupamento por proximidade real** — clusters devem

   refletir distância geométrica real entre pontos, sem depender do

   alinhamento de uma grade fixa arbitrária (ver "Abordagens já avaliadas"

   abaixo para o porquê disso importar).

3. **Sem rebuild periódico/global** — a estrutura deve permanecer

   consistente e consultável a qualquer momento, sem uma etapa de

   reprocessamento completo do dataset.



## Abordagens já avaliadas (e por que não resolvem completamente)



| Abordagem | Atende (1)? | Atende (2)? | Atende (3)? | Observação |

|---|---|---|---|---|

| Rebuild periódico com [`supercluster`](https://github.com/mapbox/supercluster) (KD-tree estático via `kdbush`) | Não — O(N log N) por rebuild | Sim | Não | Padrão de indústria; usado com cache de tiles (x/y/z) para servir leituras |

| Clustering por grid fixo (bucket em células, ex. tiles Web Mercator) | Sim — O(1) por update | Não — artefatos de corte e fusão indevida na borda de célula | Sim | Mitigável parcialmente com offset grids ou multi-resolução |

| CF-tree (estrutura do algoritmo BIRCH) / R-tree dinâmico com agregados por nó (count, soma, soma de quadrados) | Parcial — O(log N) em teoria, mas degrada sem rebalanceamento cuidadoso | Sim, se a árvore estiver bem balanceada | Sim, em teoria | Não há biblioteca madura e popular aplicando isso especificamente a clustering de mapas em tempo real, até onde sabemos |

| Método logarítmico de Bentley–Saxe (transforma estrutura estática em dinâmica via múltiplos índices em potências de 2) | Parcial — O(log² N) amortizado para inserção; deleção é o ponto fraco | Sim | Parcial — funde índices, mas não elimina reprocessamento periódico para deleções | Desenhado para inserção pura; "mover um ponto" = deletar + inserir, o que reintroduz custo periódico |

| "Dirty region" — busca por vizinhança via R-tree dinâmico (ex. `rbush`) + clustering guloso só na vizinhança afetada | Sim — O(D log N), D = densidade local | Sim | Sim | Meio-termo mais viável identificado até agora, mas não é uma solução "pronta", precisa ser construída |



## O que buscamos que uma pesquisa aprofundada possa esclarecer



1. Existe algoritmo ou estrutura de dados publicada — especialmente em

   trabalhos recentes (últimos 2-5 anos) — de **fully dynamic hierarchical

   clustering** ou **dynamic k-center/k-means clustering** com garantias de

   atualização em tempo polilogarítmico e aproximação de qualidade em

   relação ao clustering ótimo estático?

2. Existem implementações práticas (não só teóricas) dessas estruturas

   aplicadas especificamente a **clustering geoespacial para visualização em

   mapas** (análogo ao problema que o supercluster resolve, mas de forma

   incremental)?

3. Sistemas de produção em grande escala (Uber H3, Google S2, Mapbox,

   Kepler.gl, deck.gl, Tile38, ferramentas de observabilidade geoespacial

   como as usadas em frotas/logística) documentam publicamente como lidam

   com esse trade-off? Algum deles implementou algo além de grid

   hierárquico ou rebuild periódico?

4. O problema tem nome estabelecido na literatura de geometria

   computacional ou streaming algorithms que facilite a busca (termos

   candidatos: *dynamic spatial clustering*, *streaming clustering with

   coresets*, *incremental hierarchical clustering*, *dynamic R-tree

   rebalancing*, *online clustering maintenance*)?



## Termos-chave sugeridos para busca



- fully dynamic clustering algorithm

- incremental hierarchical clustering spatial data

- dynamic k-center / k-means streaming

- CF-tree BIRCH incremental spatial index

- R*-tree dynamic rebalancing clustering

- coreset streaming spatial clustering

- Bentley-Saxe logarithmic method deletion

- real-time map clustering algorithm production system



## Critério de sucesso da pesquisa



Uma resposta satisfatória deve incluir, para qualquer algoritmo/estrutura

proposta:



- Complexidade de tempo por atualização (inserção/remoção/movimento de 1

  ponto), em função de N (total) e/ou D (densidade local).

- Complexidade de tempo por consulta (ex. "clusters visíveis em um

  viewport, dado um zoom").

- Se e como a estrutura lida com **degradação de qualidade sob updates

  contínuos** (ou seja, se precisa de algum rebalanceamento e com que

  custo).

- Se existe implementação de referência (biblioteca, paper com código,

  ou sistema de produção documentado) ou é puramente teórico.



## Nota de honestidade



Não temos certeza de que uma solução atendendo plenamente às três

propriedades exista de forma prática e madura — a suspeita, baseada na

prática observada da indústria (que majoritariamente usa grid hierárquico

ou rebuild periódico), é que existe uma tensão real entre as três, não

apenas uma lacuna de biblioteca. Mas isso é uma observação empírica, não

uma prova formal de impossibilidade — daí o valor de uma pesquisa dedicada.
