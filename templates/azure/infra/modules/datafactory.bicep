// Azure Data Factory factory + linked services + integration runtime + triggers.
// One module invocation per integration when any IR flow has implementation.host == 'data-factory'.
// Pipelines themselves live in <integration-folder>/adf/pipelines/ and are deployed
// either via this Bicep (resource-by-resource) or by `az datafactory pipeline create-or-update`
// in CI/CD. Reference: .github/skills/data-factory/SKILL.md

param workload string
param env string
param location string
param tags object

@description('User-assigned managed identity resource id used by the factory and linked services.')
param userAssignedIdentityId string

@description('Optional Storage account name for blob/ADLS linked services (uses MI auth).')
param storageAccountName string = ''

@description('Optional Key Vault name for secret-referenced linked services.')
param keyVaultName string = ''

@description('Linked service definitions (name + type-properties) sourced from adf/linkedServices/.')
param linkedServices array = []

@description('Dataset definitions sourced from adf/datasets/.')
param datasets array = []

@description('Pipeline definitions sourced from adf/pipelines/. Each entry: { name, activities, parameters, variables }.')
param pipelines array = []

@description('Trigger definitions sourced from adf/triggers/.')
param triggers array = []

@description('Self-Hosted Integration Runtime name when on-prem data movement is required. Leave empty to use only AutoResolveIntegrationRuntime.')
param selfHostedIrName string = ''

param logAnalyticsWorkspaceId string

var factoryName = 'adf-${workload}-${env}-${location}'

resource factory 'Microsoft.DataFactory/factories@2018-06-01' = {
  name: factoryName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    publicNetworkAccess: 'Disabled'
  }
}

// Self-Hosted IR (optional). AutoResolveIntegrationRuntime is implicit and needs no resource.
resource selfHostedIr 'Microsoft.DataFactory/factories/integrationRuntimes@2018-06-01' = if (!empty(selfHostedIrName)) {
  parent: factory
  name: selfHostedIrName
  properties: {
    type: 'SelfHosted'
    description: 'On-prem / private-network data movement runtime'
  }
}

@batchSize(1)
resource linkedServiceResources 'Microsoft.DataFactory/factories/linkedservices@2018-06-01' = [for ls in linkedServices: {
  parent: factory
  name: ls.name
  properties: ls.properties
}]

@batchSize(1)
resource datasetResources 'Microsoft.DataFactory/factories/datasets@2018-06-01' = [for ds in datasets: {
  parent: factory
  name: ds.name
  properties: ds.properties
  dependsOn: linkedServiceResources
}]

@batchSize(1)
resource pipelineResources 'Microsoft.DataFactory/factories/pipelines@2018-06-01' = [for p in pipelines: {
  parent: factory
  name: p.name
  properties: {
    activities: p.activities
    parameters: contains(p, 'parameters') ? p.parameters : {}
    variables: contains(p, 'variables') ? p.variables : {}
    annotations: contains(p, 'annotations') ? p.annotations : []
  }
  dependsOn: datasetResources
}]

@batchSize(1)
resource triggerResources 'Microsoft.DataFactory/factories/triggers@2018-06-01' = [for t in triggers: {
  parent: factory
  name: t.name
  properties: t.properties
  dependsOn: pipelineResources
}]

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag'
  scope: factory
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'PipelineRuns', enabled: true }
      { category: 'TriggerRuns', enabled: true }
      { category: 'ActivityRuns', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output name string = factory.name
output id string = factory.id
