# Tasks: <Integration Name>

<!-- produced by task-decomposer -->

Legend: `[P]` = parallelizable with siblings. `depends:` = direct predecessors.

## Phase 0 - Scaffolding

- [ ] T001 Create platform project skeleton  (depends: -)  <links: plan Phase 0>
- [ ] T002 [P] Commit .gitignore and editor config  (depends: T001)

## Phase 1 - Contracts in place

- [ ] T010 Generate mocks from OpenAPI  (depends: T001)  <links: contracts/openapi.yaml>
- [ ] T011 [P] Generate mocks from AsyncAPI  (depends: T001)  <links: contracts/asyncapi.yaml>

## Phase 2 - Per-flow implementation

### Flow: <FlowName>

- [ ] T100 Write unit tests for <FlowName>.<stepId>  (depends: T010, T011)  <links: FR-1, IR:flow.<FlowName>.step.<stepId>>
- [ ] T101 Implement <FlowName>.<stepId>  (depends: T100)  <links: FR-1>

## Phase 3 - Infrastructure

- [ ] T200 Author IaC for messaging  (depends: T001)  <links: plan Phase 3>

## Phase 4 - CI/CD

- [ ] T300 Author CI pipeline  (depends: T200)

## Phase 5 - Verification tasks

- [ ] T900 End-to-end test FR-1  (depends: T101)  <links: FR-1>

Task count: 0 total, 0 parallelizable.
