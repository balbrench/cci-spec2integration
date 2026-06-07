targetScope = 'resourceGroup'

@description('Environment (dev | prod)')
param env string

@description('Workload name from IR metadata.name')
param workload string

@description('Azure region')
param location string = resourceGroup().location

@description('Owner from IR metadata.owner')
param owner string

@description('Domain from IR metadata.domain')
param domain string

@description('Service Bus fully-qualified namespace (or KeyVault reference via parameter file)')
param serviceBusFullyQualifiedNamespace string = ''

var tags = {
  workload: workload
  env: env
  owner: owner
  domain: domain
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    workload: workload
    env: env
    location: location
    tags: tags
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    workload: workload
    env: env
    location: location
    tags: tags
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    workload: workload
    env: env
    location: location
    tags: tags
  }
}

module serviceBus 'modules/servicebus.bicep' = {
  name: 'servicebus'
  params: {
    workload: workload
    env: env
    location: location
    tags: tags
    principalId: identity.outputs.principalId
  }
}

module logicapp 'modules/logicapp.bicep' = {
  name: 'logicapp'
  params: {
    workload: workload
    env: env
    location: location
    tags: tags
    storageAccountId: storage.outputs.id
    storageAccountName: storage.outputs.name
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    userAssignedIdentityId: identity.outputs.id
    serviceBusFullyQualifiedNamespace: serviceBusFullyQualifiedNamespace
  }
}

output logicAppName string = logicapp.outputs.name
output logicAppHost string = logicapp.outputs.defaultHostName
output principalId string = identity.outputs.principalId
