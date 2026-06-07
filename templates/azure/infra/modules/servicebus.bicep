param workload string
param env string
param location string
param tags object
param principalId string
param topics array = []
param queues array = []

var namespaceName = 'sb-${workload}-${env}-${location}'

resource namespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: namespaceName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    disableLocalAuth: true
  }
}

resource topicResources 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' = [for t in topics: {
  parent: namespace
  name: t
  properties: {
    supportOrdering: false
  }
}]

resource queueResources 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = [for q in queues: {
  parent: namespace
  name: q
  properties: {
    deadLetteringOnMessageExpiration: true
    maxDeliveryCount: 5
  }
}]

var sbDataSender  = resourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39')
var sbDataReceiver = resourceId('Microsoft.Authorization/roleDefinitions', '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0')

resource roleSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(namespace.id, principalId, 'sender')
  scope: namespace
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: sbDataSender
  }
}

resource roleReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(namespace.id, principalId, 'receiver')
  scope: namespace
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: sbDataReceiver
  }
}

output namespaceName string = namespace.name
output namespaceFqdn string = '${namespace.name}.servicebus.windows.net'
