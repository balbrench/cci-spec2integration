// Stand-alone .NET 8 isolated-worker Function App.
// One module invocation per IR flow whose implementation.host == 'function-app'.
// Sibling to the Logic Apps Standard site; never colocated.
// Reference: .github/skills/azure-functions/SKILL.md

param workload string
param env string
param location string
param tags object

@description('Short flow name used to disambiguate this Function App from siblings (e.g. orderRouter).')
param flowName string

@description('Hosting plan tier. Allowed: FlexConsumption | Consumption | EP1 | EP2 | EP3 | P1v3 | P2v3 | P3v3.')
@allowed([
  'FlexConsumption'
  'Consumption'
  'EP1'
  'EP2'
  'EP3'
  'P1v3'
  'P2v3'
  'P3v3'
])
param hostingPlan string = 'FlexConsumption'

@description('Dedicated storage account name for this Function App (AzureWebJobsStorage identity binding).')
param storageAccountName string

param appInsightsConnectionString string
param logAnalyticsWorkspaceId string
param userAssignedIdentityId string

@description('Optional Service Bus FQDN injected when the flow binds to queue/topic channels.')
param serviceBusFullyQualifiedNamespace string = ''

@description('Optional Event Hubs FQDN injected when the flow binds to eventhub channels.')
param eventHubsFullyQualifiedNamespace string = ''

@description('Extra app settings (name/value pairs) merged on top of the defaults.')
param extraAppSettings array = []

var safeFlow = toLower(replace(flowName, '_', '-'))
var functionAppName = 'func-${workload}-${safeFlow}-${env}-${location}'
var planName = 'plan-fn-${workload}-${safeFlow}-${env}-${location}'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

// Plan shape varies by hostingPlan. FlexConsumption uses kind: 'functionapp,linux'
// + sku FC1 with linuxFxVersion 'DOTNET-ISOLATED|8.0'. Consumption uses 'Y1' Dynamic.
// Premium uses 'EP*' ElasticPremium. Dedicated uses 'P*v3' PremiumV3.
var isFlex = hostingPlan == 'FlexConsumption'
var isConsumption = hostingPlan == 'Consumption'
var isPremium = startsWith(hostingPlan, 'EP')
var isDedicated = startsWith(hostingPlan, 'P') && !isPremium

var planSkuName = isFlex ? 'FC1' : (isConsumption ? 'Y1' : hostingPlan)
var planSkuTier = isFlex ? 'FlexConsumption' : (isConsumption ? 'Dynamic' : (isPremium ? 'ElasticPremium' : 'PremiumV3'))

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  sku: {
    name: planSkuName
    tier: planSkuTier
  }
  kind: 'functionapp'
  properties: {
    reserved: true
  }
}

var defaultAppSettings = [
  { name: 'AzureWebJobsStorage__accountName', value: storage.name }
  { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
  { name: 'AzureWebJobsStorage__clientId', value: reference(userAssignedIdentityId, '2023-01-31').clientId }
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'dotnet-isolated' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
]

var sbSettings = empty(serviceBusFullyQualifiedNamespace) ? [] : [
  { name: 'ServiceBusConnection__fullyQualifiedNamespace', value: serviceBusFullyQualifiedNamespace }
  { name: 'ServiceBusConnection__credential', value: 'managedidentity' }
  { name: 'ServiceBusConnection__clientId', value: reference(userAssignedIdentityId, '2023-01-31').clientId }
]

var ehSettings = empty(eventHubsFullyQualifiedNamespace) ? [] : [
  { name: 'EventHubsConnection__fullyQualifiedNamespace', value: eventHubsFullyQualifiedNamespace }
  { name: 'EventHubsConnection__credential', value: 'managedidentity' }
  { name: 'EventHubsConnection__clientId', value: reference(userAssignedIdentityId, '2023-01-31').clientId }
]

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: userAssignedIdentityId
    siteConfig: {
      linuxFxVersion: isFlex ? null : 'DOTNET-ISOLATED|8.0'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: concat(defaultAppSettings, sbSettings, ehSettings, extraAppSettings)
    }
    functionAppConfig: isFlex ? {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}deploy-${safeFlow}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: userAssignedIdentityId
          }
        }
      }
      runtime: {
        name: 'dotnet-isolated'
        version: '8.0'
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
    } : null
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag'
  scope: functionApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'FunctionAppLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output name string = functionApp.name
output principalId string = reference(userAssignedIdentityId, '2023-01-31').principalId
output defaultHostName string = functionApp.properties.defaultHostName
