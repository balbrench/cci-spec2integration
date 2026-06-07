# BizTalk Inventory: <Solution Name>

<!-- produced by biztalk-inventory; do not hand-edit after initial generation -->

- **Solution path:** <path>
- **Scanned:** <ISO-8601 datetime>
- **BizTalk projects:** N

## Summary

| Artifact type         | Count | Auto | Local-fn | Azure-fn | Manual |
|-----------------------|-------|------|----------|----------|--------|
| Orchestrations (.odx) |       |      |          |          |        |
| Maps (.btm)           |       |      |          |          |        |
| Schemas (.xsd)        |       |      |          |          |        |
| Pipelines (.btp)      |       |      |          |          |        |
| Binding files         |       |      |          |          |        |
| BRE policies          |       |      |          |          |        |
| Binary deps (.dll)    |       |      |          |          |        |

## Integration Groups

### Group: <GroupName>

- **Boundary:** <inbound adapter type> → <process> → <outbound adapter type>
- **Receive ports:** <list>
- **Send ports:** <list>
- **Orchestrations:** <list>
- **Maps:** <list>
- **Schemas:** <list>

## Orchestrations

| Name | File | Shapes | External calls | Compensation | Complexity |
|------|------|--------|----------------|--------------|------------|
| <Name> | <path> | N | <list or none> | yes/no | auto/local-function/azure-function/manual |

## Maps

| Name | File | Source schema | Target schema | Scripting functoids | Custom DLL refs | XSLT override | Complexity |
|------|------|---------------|---------------|---------------------|-----------------|---------------|------------|
| <Name> | <path> | <schema> | <schema> | N | N | yes/no | auto/... |

## Schemas

| Name | File | Format | Root element | Notes | Complexity |
|------|------|--------|--------------|-------|------------|
| <Name> | <path> | xsd/flat-file/edi/property | <element> | <notes> | auto/azure-function/manual |

## Pipelines

| Name | File | Type | Components | Custom components | Complexity |
|------|------|------|------------|-------------------|------------|
| <Name> | <path> | receive/send | <list> | <list or none> | auto/... |

## Bindings

| Port name | Type | Direction | Adapter | Address | Auth hint |
|-----------|------|-----------|---------|---------|-----------|
| <Name> | send/receive | inbound/outbound | HTTP/SAP/SQL/MQ/SFTP/FILE/WCF-* | <address> | <hint> |

## BRE Policies

| Policy name | File | Major rev | Vocabularies | External .NET | Complexity |
|-------------|------|-----------|--------------|---------------|------------|
| <Name> | <path> | N | <list> | yes/no | auto/... |

## MSI Artifacts

| MSI file | Extracted artifact | Type | Matching source | Notes |
|----------|--------------------|------|-----------------|-------|
| <Name>.msi | <filename> | binding/xslt/dll/other | yes/no | <notes> |

## MSI vs Source Discrepancies

| Port name | MSI address | Source address | Recommendation |
|-----------|------------|----------------|----------------|
| <Name> | <deployed address> | <source address> | Use MSI value / investigate |

## Binary Dependencies

| Assembly | Version | Referenced by | Stub path | Action required |
|----------|---------|---------------|-----------|-----------------|
| <Name> | <version> | <artifact list> | artifacts/custom/<Name>.dll.stub | Manual implementation required |

## Open Issues

<!-- Artifacts that could not be classified, parsed, or require human review -->

- <issue description>
