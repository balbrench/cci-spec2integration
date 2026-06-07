param workload string
param env string
param location string
param tags object

var logWorkspaceName = 'log-${workload}-${env}-${location}'
var appInsightsName = 'appi-${workload}-${env}-${location}'

resource log 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logWorkspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: log.id
  }
}

output logAnalyticsWorkspaceId string = log.id
output appInsightsConnectionString string = appi.properties.ConnectionString
