# Local bug index for related-bug search

Status: idea, not decided. From the team lead, 2026-10-19: "build a local index and refresh it
periodically". Discussed the same day; nothing built.

## Problem it addresses

Related-bug search today relies on Jira's `~` text search, driven by two or three JQL queries the
agent improvises per bug. That has three weaknesses, all seen in the dry run:

- no ranking: `~` returns matches in `updated` order, not by relevance;
- no notion of meaning: a bug described in other words is missed unless the agent guesses the
  synonym;
- no determinism: the same bug gets different related bugs on different runs, because the queries
  differ.

## The idea

Keep a local copy of every KAZ and RPG bug (key, summary, description, status, resolution,
updated) in SQLite next to the state database, indexed for similarity search. The program queries
it for the top 10–20 candidates and puts them into the agent's prompt; the agent still decides
which share the symptom and keeps `get_issue` to read a candidate. The index is the retrieval
half only; judgement stays with the model.

Scale: KAZ + RPG are about 15k issues. One file, rebuilt in a minute, fits in memory.

## Three ways

| | Lexical | Semantic | Hybrid |
|---|---|---|---|
| Idea | SQLite FTS5 with BM25 ranking over summary + description | One embedding vector per bug; cosine similarity | Both lists merged with reciprocal rank fusion |
| Finds | Same words, other order; stems (logout / logged out) | Other words, same meaning | The union, ranked |
| Needs | Nothing: FTS5 is built into SQLite | An embedding model: an API (Anthropic's docs point to Voyage AI; check the current models) or a local one | Both |
| Cost | Zero | Cents for the backlog once, then per new bug | As semantic |
| Weak spot | Synonyms it was not told about | May rank a vaguely similar bug above an exact one; opaque when wrong | More parts |

Refresh, the same for all three: a JQL `updated >= <last refresh>` on the existing poll cadence,
upsert the changed rows, re-embed only those. A full rebuild as a command. An index that silently
stops refreshing is the failure mode to design against: log the refresh, show its age in the UI.

Tokenisation detail that matters here: board types such as `NPB-Ie6-XL` must stay one token.

## How to decide

Build the measuring stick first. Jira holds ground truth: bugs closed as *Duplicate* and the
"duplicates" links between them. For each such pair, ask every approach "is the known duplicate in
your top 10?" → recall@10 per approach on real data, in an afternoon, read-only, with the Jira
client the service already has.

Expected outcome, to be checked against that number: start with FTS5/BM25 (no dependency, no API,
deterministic); add embeddings only if the eval shows a gap.

## Concepts worth knowing to judge proposals

Tokenisation and stemming; BM25; embeddings and cosine similarity; hybrid retrieval and RRF;
recall@k and precision; incremental refresh and idempotency.

## Next step, if taken up

An eval script: fetch the duplicate pairs, build the FTS5 index, print recall@10. Then decide.
