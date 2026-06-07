using LogicAppUnit;
using LogicAppUnit.Helper;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using System.Net;
using System.Net.Http;
using System.Text.Json;

namespace <Namespace>.Tests;

[TestClass]
public class <FlowName>Tests : WorkflowTestBase
{
    [TestInitialize]
    public void TestInitialize()
    {
        Initialize("../../../../..", "<FlowName>");
    }

    [TestCleanup]
    public void TestCleanup()
    {
        Close();
    }

    [ClassCleanup]
    public static void CleanResources()
    {
        CloseClass();
    }

    [TestMethod]
    public void <FlowName>_HappyPath_ReturnsAccepted()
    {
        using var testRunner = CreateTestRunner();

        testRunner.AddApiMocks = (request) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK);
            return response;
        };

        var payload = File.ReadAllText("fixtures/<FlowName>-happy-input.json");
        var result = testRunner.TriggerWorkflow(
            ContentHelper.CreateJsonStringContent(payload),
            HttpMethod.Post);

        Assert.AreEqual(HttpStatusCode.Accepted, result.StatusCode);
        Assert.AreEqual("Succeeded", testRunner.WorkflowRunStatus.ToString());
    }

    [TestMethod]
    public void <FlowName>_DependencyFails_RoutesToDlq()
    {
        using var testRunner = CreateTestRunner();

        testRunner.AddApiMocks = (request) =>
            new HttpResponseMessage(HttpStatusCode.InternalServerError);

        var payload = File.ReadAllText("fixtures/<FlowName>-happy-input.json");
        var result = testRunner.TriggerWorkflow(
            ContentHelper.CreateJsonStringContent(payload),
            HttpMethod.Post);

        Assert.IsTrue(
            testRunner.GetWorkflowActionStatus("publishDlq") == "Succeeded",
            "DLQ branch must fire when dependency fails after retries.");
    }
}
