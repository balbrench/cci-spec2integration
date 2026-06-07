param workload string
param env string
param location string
param tags object
param storageAccountId string
param storageAccountName string
param appInsightsConnectionString string
param logAnalyticsWorkspaceId string
param userAssignedIdentityId string
param serviceBusFullyQualifiedNamespace string
param sku string = 'WS1'

var logicAppName = 'lapp-${workload}-${env}-${location}'
var planName = 'plan-${workload}-${env}-${location}'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  sku: {
    name: sku
    tier: 'WorkflowStandard'
  }
  properties: {
    reserved: false
  }
}

resource logicApp 'Microsoft.Web/sites@2023-12-01' = {
  name: logicAppName
  location: location
  tags: tags
  kind: 'functionapp,workflowapp'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      alwaysOn: false
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'dotnet' }
        { name: 'APP_KIND', value: 'workflowapp' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'WORKFLOWS_SERVICEBUS_FQDN', value: serviceBusFullyQualifiedNamespace }
      ]
    }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag'
  scope: logicApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'WorkflowRuntime', enabled: true }
      { category: 'FunctionAppLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output name string = logicApp.name
output defaultHostName string = logicApp.properties.defaultHostName
