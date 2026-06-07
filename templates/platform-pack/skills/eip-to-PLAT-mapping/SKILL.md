---
name: eip-to-<plat>-mapping
description: Mapping from Integration IR node types and channel kinds to <Platform Name> native constructs.
---

# EIP → <Platform Name> mapping

Use this when compiling IR steps to <Platform Name>-native artifacts.

## Node types

Fill in the right column with the native construct for each EIP node type.

| IR `type`       | Native <Platform Name> construct | Notes |
|-----------------|----------------------------------|-------|
| `receive`       | <!-- TODO -->                    | Bind schema from `messages[].schemaRef`. |
| `transform`     | <!-- TODO -->                    | Chosen by `mappings[mappingRef].engine`; see "Compiling mappings" below. |
| `enrich`        | <!-- TODO -->                    | Call dependency, then merge response using `mappingRef`. |
| `filter`        | <!-- TODO -->                    | False branch terminates or routes to DLQ. |
| `router`        | <!-- TODO -->                    | One branch per route; compile `when` predicates. |
| `recipientList` | <!-- TODO -->                    | Parallel fan-out; one branch per target. |
| `splitter`      | <!-- TODO -->                    | Iterate over collection. |
| `aggregator`    | <!-- TODO -->                    | Collect N correlated messages; declare correlation key and timeout. |
| `scatterGather` | <!-- TODO -->                    | Parallel fan-out + merge response. |
| `send`          | <!-- TODO -->                    | Publish to outbound channel using managed identity. |
| `invoke`        | <!-- TODO -->                    | Synchronous HTTP call with retry policy from IR. |

## Channel kinds

| IR `kind`  | Native resource / binding      | Auth                        |
|------------|--------------------------------|-----------------------------|
| `http`     | <!-- TODO -->                  | <!-- TODO -->               |
| `queue`    | <!-- TODO -->                  | Managed identity            |
| `topic`    | <!-- TODO -->                  | Managed identity            |
| `blob`     | <!-- TODO -->                  | Managed identity            |
| `timer`    | <!-- TODO -->                  | N/A                         |
| `eventgrid`| <!-- TODO -->                  | Managed identity            |

## Compiling mappings

| IR `engine`   | Native transform construct | Notes |
|---------------|---------------------------|-------|
| `jsonata`     | <!-- TODO -->             | Default. |
| `xslt`        | <!-- TODO -->             | XML-to-XML only. |
| `liquid`      | <!-- TODO -->             | Template output. |
| `expression`  | <!-- TODO -->             | Whole-document expression. |

### Migration-mode mappings (Article II.a)

When a mapping has `origin: preserved`, do NOT compile from `rules` or `engine` defaults. Instead read `transforms.<this-pack-id>` and select the adapter:

| `transforms.<pack>` value      | Action                                                                                       |
|--------------------------------|----------------------------------------------------------------------------------------------|
| `passthrough`                  | Copy `sourceArtifact.xslt` (or equivalent) byte-for-byte to the platform's native location.   |
| `xslt_to_dataweave`            | Run the named XSLT-to-DataWeave adapter on `sourceArtifact.xslt`.                            |
| `xslt_to_local_function`       | Wrap `sourceArtifact.xslt` in a .NET local function and emit an `InvokeFunction` action.     |
| `xslt_to_azure_function`       | Wrap in an Azure Function and emit an HTTP call.                                             |
| `regenerate`                   | Explicit opt-in to translate `rules` into native syntax. Rare \u2014 documented exception only.   |

For each preserved mapping, also wire every `parameters[].name` into the action's parameter slot using the declared `binding` value verbatim (it is already in your platform's native expression language).

## Compiling predicates

| Predicate style            | Native expression |
|----------------------------|-------------------|
| JSONata boolean expression | <!-- TODO -->     |

## Retry policy mapping

| IR `errorHandling.retry.policy` | Native retry setting |
|---------------------------------|----------------------|
| `fixed`                         | <!-- TODO -->        |
| `exponential`                   | <!-- TODO -->        |

## Correlation id propagation

Describe how to carry the correlation id through every outbound action:

<!-- TODO: provide a concrete snippet showing how to read the inbound correlation id
     and set it on every outbound request / message. -->

## Secret and parameter references

Describe how parameters and secret-store references from the IR are resolved at runtime:

<!-- TODO -->
