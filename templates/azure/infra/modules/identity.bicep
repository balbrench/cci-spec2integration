param workload string
param env string
param location string
param tags object

var identityName = 'mi-${workload}-${env}'

resource mi 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

output id string = mi.id
output name string = mi.name
output principalId string = mi.properties.principalId
output clientId string = mi.properties.clientId
