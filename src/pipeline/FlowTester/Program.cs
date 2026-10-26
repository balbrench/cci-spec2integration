using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

var exitCode = await FlowTesterProgram.RunAsync(args);
return exitCode;

internal static class FlowTesterProgram
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("Usage: FlowTester <integration-folder>");
            return 1;
        }

        var integrationFolder = Path.GetFullPath(args[0]);
        var irPath = Path.Combine(integrationFolder, "integration-ir.yaml");

        if (!File.Exists(irPath))
        {
            var missingReport = CreateBlockedReport(
                "IR_MISSING",
                "integration-ir.yaml not found.");

            await WriteReportsAsync(integrationFolder, missingReport);
            PrintSummary(missingReport);
            return 1;
        }

        var runtimeCheck = await RuntimePrerequisite.CheckAsync();
        if (!runtimeCheck.Success)
        {
            var blockedReport = CreateBlockedReport(
                "RUNTIME_MISSING",
                "flow tests not executed — node or the jsonata package could not be found. Install Node.js and jsonata (`npm install -g jsonata` or `npm install jsonata` in the repo), then retry.");

            await WriteReportsAsync(integrationFolder, blockedReport);
            PrintSummary(blockedReport);
            return 1;
        }

        IntegrationDocument document;
        try
        {
            document = await LoadIntegrationDocumentAsync(irPath);
        }
        catch (Exception exception)
        {
            var blockedReport = CreateBlockedReport(
                "IR_PARSE_FAILED",
                $"integration-ir.yaml could not be parsed: {exception.Message}");

            await WriteReportsAsync(integrationFolder, blockedReport);
            PrintSummary(blockedReport);
            return 1;
        }

        var runner = new FlowTestRunner(document, integrationFolder);
        var report = await runner.RunAsync();
        await WriteReportsAsync(integrationFolder, report);
        PrintSummary(report);

        return report.Summary.Verdict == "PASS" ? 0 : 1;
    }

    private static async Task<IntegrationDocument> LoadIntegrationDocumentAsync(string irPath)
    {
        var yaml = await File.ReadAllTextAsync(irPath);
        var deserializer = new DeserializerBuilder()
            .WithNamingConvention(CamelCaseNamingConvention.Instance)
            .IgnoreUnmatchedProperties()
            // Unquoted scalars bound to `object` (test context values, rule defaults)
            // become bool / number / null as YAML intends; quoted ones stay strings.
            .WithAttemptingUnquotedStringTypeDeserialization()
            .Build();

        return deserializer.Deserialize<IntegrationDocument>(yaml)
            ?? throw new InvalidOperationException("integration-ir.yaml deserialized to null.");
    }

    private static FlowTestReport CreateBlockedReport(string code, string detail)
    {
        return new FlowTestReport
        {
            Generated = DateTimeOffset.UtcNow.ToString("o"),
            Summary = new FlowTestSummary
            {
                Passed = 0,
                Failed = 0,
                Skipped = 0,
                Verdict = "BLOCKED",
            },
            Results =
            [
                new FlowTestResult
                {
                    Flow = code,
                    Test = code,
                    Result = "FAIL",
                    Detail = detail,
                },
            ],
        };
    }

    private static async Task WriteReportsAsync(string integrationFolder, FlowTestReport report)
    {
        var markdownPath = Path.Combine(integrationFolder, "flow-test-report.md");
        var jsonPath = Path.Combine(integrationFolder, "flow-test-report.json");

        var markdown = MarkdownReportWriter.Write(report);
        var json = JsonSerializer.Serialize(report, JsonOptions);

        await File.WriteAllTextAsync(markdownPath, markdown);
        await File.WriteAllTextAsync(jsonPath, json + Environment.NewLine);
    }

    private static void PrintSummary(FlowTestReport report)
    {
        Console.WriteLine(
            $"Flow tests: {report.Summary.Passed} passed, {report.Summary.Failed} failed, {report.Summary.Skipped} skipped — {report.Summary.Verdict}");
    }
}

internal sealed class FlowTestRunner
{
    private readonly IntegrationDocument _document;
    private readonly string _integrationFolder;
    private readonly Dictionary<string, ChannelDefinition> _channels;
    private readonly Dictionary<string, MessageDefinition> _messages;
    private readonly Dictionary<string, MappingDefinition> _mappings;
    private readonly JsonataEvaluator _jsonataEvaluator;

    public FlowTestRunner(IntegrationDocument document, string integrationFolder)
    {
        _document = document;
        _integrationFolder = integrationFolder;
        _channels = document.Channels?.Where(channel => !string.IsNullOrWhiteSpace(channel.Name)).ToDictionary(channel => channel.Name!, StringComparer.Ordinal) ?? new();
        _messages = document.Messages?.Where(message => !string.IsNullOrWhiteSpace(message.Name)).ToDictionary(message => message.Name!, StringComparer.Ordinal) ?? new();
        _mappings = document.Mappings?.Where(mapping => !string.IsNullOrWhiteSpace(mapping.Name)).ToDictionary(mapping => mapping.Name!, StringComparer.Ordinal) ?? new();
        _jsonataEvaluator = new JsonataEvaluator();
    }

    public async Task<FlowTestReport> RunAsync()
    {
        var results = new List<FlowTestResult>();

        foreach (var flow in _document.Flows ?? [])
        {
            if (flow.Tests is null || flow.Tests.Count == 0)
            {
                continue;
            }

            foreach (var test in flow.Tests)
            {
                var result = await RunTestAsync(flow, test);
                results.Add(result);
            }
        }

        var summary = new FlowTestSummary
        {
            Passed = results.Count(result => result.Result == "PASS"),
            Failed = results.Count(result => result.Result == "FAIL"),
            Skipped = results.Count(result => result.Result == "SKIP"),
        };
        summary.Verdict = summary.Failed > 0 ? "BLOCKED" : "PASS";

        return new FlowTestReport
        {
            Generated = DateTimeOffset.UtcNow.ToString("o"),
            Summary = summary,
            Results = results,
        };
    }

    private async Task<FlowTestResult> RunTestAsync(FlowDefinition flow, FlowDefinitionTest test)
    {
        try
        {
            var payload = await LoadJsonAsync(ResolveRelativePath(test.Trigger?.Path));
            var context = JsonNodeFactory.ObjectFromDictionary(test.Context);
            var requestHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var pinnedKeys = new HashSet<string>(test.Context?.Keys ?? Enumerable.Empty<string>(), StringComparer.Ordinal);

            // A trigger fixture may be the raw message or a run envelope { body, headers, context }
            // (mapping-test fixtures are envelopes). An envelope is unwrapped: body becomes the
            // trigger message; its headers and context sit under the test's own values.
            if (IsEnvelope(payload))
            {
                var envelope = (JsonObject)payload!;
                if (envelope["headers"] is JsonObject envelopeHeaders)
                {
                    foreach (var header in envelopeHeaders)
                    {
                        requestHeaders[header.Key] = header.Value?.ToString() ?? string.Empty;
                    }
                }

                if (envelope["context"] is JsonObject envelopeContext)
                {
                    foreach (var contextValue in envelopeContext)
                    {
                        if (!context.ContainsKey(contextValue.Key))
                        {
                            context[contextValue.Key] = contextValue.Value?.DeepClone();
                            pinnedKeys.Add(contextValue.Key);
                        }
                    }
                }

                payload = envelope["body"]?.DeepClone();
            }

            foreach (var header in test.Trigger?.Headers ?? [])
            {
                requestHeaders[header.Key] = header.Value;
            }

            var state = new ExecutionState(context, requestHeaders, test.Faults ?? [], _document.ErrorHandling, flow.ErrorHandling);
            state.PinnedContextKeys.UnionWith(pinnedKeys);

            var entry = flow.Steps?.FirstOrDefault();
            if (string.IsNullOrWhiteSpace(entry?.Id))
            {
                return Fail(flow.Name, test.Name, "flow has no entry step.");
            }

            state.TriggerMessage = payload?.DeepClone();
            state.TriggerType = entry!.Type == "receive" ? ResolveChannelMessage(entry.Channel) : null;
            try
            {
                await ExecuteStepAsync(flow, entry.Id!, payload, state.TriggerType, state);
            }
            catch (UnhandledStepException unhandled)
            {
                await DeadLetterRunAsync(flow, unhandled, state);
            }

            var failure = await ValidateExpectationsAsync(flow, test, state);
            return failure is null
                ? Pass(flow.Name, test.Name)
                : Fail(flow.Name, test.Name, failure);
        }
        catch (Exception exception)
        {
            return Fail(flow.Name, test.Name, exception.Message);
        }
    }

    private async Task<string?> ValidateExpectationsAsync(FlowDefinition flow, FlowDefinitionTest test, ExecutionState state)
    {
        foreach (var expectation in test.Expect ?? [])
        {
            if (!string.IsNullOrWhiteSpace(expectation.Step))
            {
                if (!state.ReachedSteps.Contains(expectation.Step!))
                {
                    return $"expected step '{expectation.Step}', but it was not reached";
                }

                continue;
            }

            if (!string.IsNullOrWhiteSpace(expectation.Channel))
            {
                var emitted = state.EmittedMessages.FirstOrDefault(message => string.Equals(message.Channel, expectation.Channel, StringComparison.Ordinal));
                if (emitted is null)
                {
                    var seen = state.EmittedMessages.Count == 0
                        ? "no outbound channels"
                        : string.Join(", ", state.EmittedMessages.Select(message => $"'{message.Channel}'").Distinct(StringComparer.Ordinal));

                    return $"expected channel '{expectation.Channel}', saw {seen}";
                }

                if (!string.IsNullOrWhiteSpace(expectation.Body?.Path))
                {
                    var expectedBody = await LoadJsonAsync(ResolveRelativePath(expectation.Body.Path));
                    if (!JsonNode.DeepEquals(expectedBody, emitted.Body))
                    {
                        return JsonDiff.Describe(expectedBody, emitted.Body, $"channel '{expectation.Channel}' body");
                    }
                }

                if (expectation.Headers is not null)
                {
                    foreach (var header in expectation.Headers)
                    {
                        if (!emitted.Headers.TryGetValue(header.Key, out var actualValue))
                        {
                            return $"expected header '{header.Key}' on channel '{expectation.Channel}', but it was missing";
                        }

                        if (!string.Equals(actualValue, header.Value, StringComparison.Ordinal))
                        {
                            return $"header mismatch on channel '{expectation.Channel}' for '{header.Key}': expected '{header.Value}', actual '{actualValue}'";
                        }
                    }
                }

                continue;
            }

            if (expectation.Error is not null)
            {
                var emitted = state.EmittedMessages.FirstOrDefault(message => string.Equals(message.Channel, expectation.Error.DlqChannel, StringComparison.Ordinal));
                if (emitted is null)
                {
                    return $"expected DLQ channel '{expectation.Error.DlqChannel}', but no DLQ message was emitted";
                }
            }
        }

        return null;
    }

    // Step execution implements the run-envelope rules in docs/ir-spec.md: expressions see
    // { body, headers, context }; produced messages are kept at context.<lowerCamel(type)>;
    // a failed step retries, then follows onError (fallback / continue / dlq); anything
    // unhandled propagates to the run, which dead-letters the trigger message.
    private async Task ExecuteStepAsync(FlowDefinition flow, string stepId, JsonNode? currentMessage, string? currentType, ExecutionState state)
    {
        var steps = flow.Steps?.Where(step => !string.IsNullOrWhiteSpace(step.Id)).ToDictionary(step => step.Id!, StringComparer.Ordinal)
            ?? throw new InvalidOperationException($"flow '{flow.Name}' has no steps.");

        if (!steps.TryGetValue(stepId, out var step))
        {
            throw new InvalidOperationException($"step '{stepId}' not found in flow '{flow.Name}'.");
        }

        state.ReachedSteps.Add(step.Id!);

        // Control-flow steps route the current message; they have no attempts of their own.
        switch (step.Type)
        {
            case "filter":
                if (await EvaluateBooleanAsync(step.Predicate, currentMessage, state))
                {
                    await ExecuteNextAsync(flow, step.Next, currentMessage, currentType, state);
                }

                return;

            case "router":
                await ExecuteRouterAsync(flow, step, currentMessage, currentType, state);
                return;

            case "recipientList":
                foreach (var target in step.Targets ?? [])
                {
                    await ExecuteStepAsync(flow, target, currentMessage?.DeepClone(), currentType, state);
                }

                await ExecuteNextAsync(flow, step.Next, currentMessage, currentType, state);
                return;

            case "splitter":
                await ExecuteSplitterAsync(flow, step, currentMessage, state);
                return;
        }

        var errorHandling = step.ErrorHandling;
        var attemptMappingRef = errorHandling?.AttemptMappingRef;
        var maxAttempts = (step.ErrorHandling?.Retry?.Count ?? step.Retry?.Count
            ?? ResolveRetryCount(null, flow.ErrorHandling, _document.ErrorHandling)) + 1;
        var record = currentMessage;
        var recordType = currentType;
        StepOutcome? outcome = null;
        Exception? lastError = null;

        for (var attempt = 1; ; attempt++)
        {
            state.StepAttempts[step.Id!] = attempt;
            lastError = null;
            try
            {
                MaybeInjectFault(step.Id!, state);
                outcome = await ExecuteActionAsync(step, currentMessage, currentType, state);
            }
            catch (Exception exception) when (exception is not UnhandledStepException)
            {
                lastError = exception;
            }

            if (!string.IsNullOrWhiteSpace(attemptMappingRef))
            {
                state.Context["attemptResult"] = lastError is null ? "succeeded" : "failed";
                if (!state.PinnedContextKeys.Contains("attemptedAt"))
                {
                    state.Context["attemptedAt"] = DateTimeOffset.UtcNow.ToString("o");
                }

                var mapped = await ApplyMappingAsync(attemptMappingRef, record, recordType, state, useGivenInput: true);
                record = mapped.Body;
                recordType = mapped.Type;
            }

            if (lastError is null || IsNonRetryable(lastError, errorHandling) || attempt >= maxAttempts)
            {
                break;
            }
        }

        if (lastError is null)
        {
            var (body, type) = string.IsNullOrWhiteSpace(attemptMappingRef)
                ? (outcome!.Body, outcome.Type)
                : (record, recordType);
            await ExecuteNextAsync(flow, step.Next, body, type, state);
            return;
        }

        var exhaustedBody = string.IsNullOrWhiteSpace(attemptMappingRef) ? currentMessage : record;
        var exhaustedType = string.IsNullOrWhiteSpace(attemptMappingRef) ? currentType : recordType;
        var onError = errorHandling?.OnError
            ?? (string.IsNullOrWhiteSpace(errorHandling?.Fallback) ? "dlq" : "fallback");

        if (onError == "fallback" && !string.IsNullOrWhiteSpace(errorHandling?.Fallback))
        {
            await ExecuteStepAsync(flow, errorHandling!.Fallback!, exhaustedBody, exhaustedType, state);
            return;
        }

        if (onError == "continue")
        {
            await ExecuteNextAsync(flow, step.Next, exhaustedBody, exhaustedType, state);
            return;
        }

        if (onError == "dlq" && !string.IsNullOrWhiteSpace(errorHandling?.Dlq?.Channel))
        {
            // Step-level DLQ: the failing step's input is parked; the run ends there.
            state.EmittedMessages.Add(new EmittedMessage(errorHandling!.Dlq!.Channel!, exhaustedBody?.DeepClone(), NewHeaders()));
            state.LastError = lastError.Message;
            return;
        }

        throw new UnhandledStepException(step.Id!, lastError);
    }

    private sealed record StepOutcome(JsonNode? Body, string? Type);

    private async Task<StepOutcome> ExecuteActionAsync(StepDefinition step, JsonNode? currentMessage, string? currentType, ExecutionState state)
    {
        switch (step.Type)
        {
            case "receive":
                var triggerType = ResolveChannelMessage(step.Channel);
                RecordHistory(triggerType, currentMessage, state);
                return new StepOutcome(currentMessage, triggerType ?? currentType);

            case "transform":
                return await ApplyMappingAsync(step.MappingRef, currentMessage, currentType, state);

            case "enrich":
            case "invoke":
            {
                var hasDependency = !string.IsNullOrWhiteSpace(step.Dependency);
                var hasMapping = !string.IsNullOrWhiteSpace(step.MappingRef);
                if (step.Type == "enrich" && !hasDependency && !hasMapping)
                {
                    return new StepOutcome(currentMessage, currentType);
                }

                JsonNode? result = hasDependency ? ResolveInvokeResponse(step, state.Context) : currentMessage;
                string? resultType = null;
                if (hasDependency && !string.IsNullOrWhiteSpace(step.ResultKey))
                {
                    state.Context[step.ResultKey!] = result?.DeepClone();
                }

                if (hasMapping)
                {
                    var mapped = await ApplyMappingAsync(step.MappingRef, currentMessage, currentType, state);
                    result = mapped.Body;
                    resultType = mapped.Type;
                }

                if (!string.IsNullOrWhiteSpace(step.ResultKey))
                {
                    state.Context[step.ResultKey!] = result?.DeepClone();
                    return new StepOutcome(currentMessage, currentType);
                }

                return new StepOutcome(result, resultType);
            }

            case "send":
                state.EmittedMessages.Add(CreateEmittedMessage(step.Channel, currentMessage, state));
                return new StepOutcome(currentMessage, currentType);

            case "claimCheck":
                state.EmittedMessages.Add(new EmittedMessage(step.Store ?? string.Empty, currentMessage?.DeepClone(), NewHeaders()));
                return new StepOutcome(currentMessage, currentType);

            case "wireTap":
                state.EmittedMessages.Add(new EmittedMessage(step.Target ?? string.Empty, currentMessage?.DeepClone(), NewHeaders()));
                return new StepOutcome(currentMessage, currentType);

            case "throttler":
            case "aggregator":
            case "scatterGather":
            case "saga":
            case "resequencer":
                return new StepOutcome(currentMessage, currentType);

            default:
                throw new InvalidOperationException($"unsupported step type '{step.Type}'.");
        }
    }

    private static Dictionary<string, string> NewHeaders() => new(StringComparer.OrdinalIgnoreCase);

    private static bool IsEnvelope(JsonNode? payload) =>
        payload is JsonObject envelope
        && envelope.ContainsKey("body")
        && envelope.All(property => property.Key is "body" or "headers" or "context");

    private static int ResolveRetryCount(ErrorHandlingDefinition? stepErrorHandling, ErrorHandlingDefinition? flowErrorHandling, ErrorHandlingDefinition? documentErrorHandling)
    {
        return stepErrorHandling?.Retry?.Count
            ?? flowErrorHandling?.Retry?.Count
            ?? documentErrorHandling?.Retry?.Count
            ?? 0;
    }

    private static bool IsNonRetryable(Exception error, ErrorHandlingDefinition? errorHandling)
    {
        var code = error is FaultInjectedException fault ? fault.Code : error.Message;
        return errorHandling?.NonRetryableErrors?.Contains(code, StringComparer.Ordinal) == true;
    }

    private void MaybeInjectFault(string stepId, ExecutionState state)
    {
        var matchingFault = state.Faults.FirstOrDefault(fault => string.Equals(fault.Step, stepId, StringComparison.Ordinal));
        if (matchingFault is null)
        {
            return;
        }

        var attempts = state.FaultAttempts.TryGetValue(stepId, out var current) ? current + 1 : 1;
        state.FaultAttempts[stepId] = attempts;
        if (attempts > matchingFault.AfterAttempts)
        {
            // `error` is the schema field; `errorCode` is accepted for older IRs.
            throw new FaultInjectedException(matchingFault.Error ?? matchingFault.ErrorCode ?? $"fault injected for step '{stepId}'.");
        }
    }

    private async Task DeadLetterRunAsync(FlowDefinition flow, UnhandledStepException unhandled, ExecutionState state)
    {
        var dlq = flow.ErrorHandling?.Dlq ?? _document.ErrorHandling?.Dlq;
        if (string.IsNullOrWhiteSpace(dlq?.Channel))
        {
            throw unhandled.InnerException ?? unhandled;
        }

        state.Context["failedStep"] = unhandled.StepId;
        var body = state.TriggerMessage?.DeepClone();
        if (!string.IsNullOrWhiteSpace(dlq!.MappingRef))
        {
            body = (await ApplyMappingAsync(dlq.MappingRef, state.TriggerMessage, state.TriggerType, state, useGivenInput: true)).Body;
        }

        state.EmittedMessages.Add(new EmittedMessage(dlq.Channel!, body, NewHeaders()));
        state.LastError = unhandled.InnerException?.Message ?? unhandled.Message;
    }

    private async Task ExecuteRouterAsync(FlowDefinition flow, StepDefinition step, JsonNode? currentMessage, string? currentType, ExecutionState state)
    {
        foreach (var route in step.Routes ?? [])
        {
            if (route.Default == true || await EvaluateBooleanAsync(route.When, currentMessage, state))
            {
                await ExecuteNextAsync(flow, route.Next, currentMessage, currentType, state);
                return;
            }
        }
    }

    private async Task ExecuteSplitterAsync(FlowDefinition flow, StepDefinition step, JsonNode? currentMessage, ExecutionState state)
    {
        if (currentMessage is not JsonArray array)
        {
            return;
        }

        foreach (var item in array)
        {
            await ExecuteNextAsync(flow, step.Next, item?.DeepClone(), null, state);
        }
    }

    private async Task ExecuteNextAsync(FlowDefinition flow, string? nextStepId, JsonNode? currentMessage, string? currentType, ExecutionState state)
    {
        if (string.IsNullOrWhiteSpace(nextStepId))
        {
            return;
        }

        await ExecuteStepAsync(flow, nextStepId!, currentMessage, currentType, state);
    }

    // Mapping input (run-envelope rule 3): the current message when it is of the mapping's
    // source type or of unknown type (e.g. an invoke response), otherwise the latest message
    // of that type from the run history. contentPath: body wraps it in the envelope.
    private async Task<StepOutcome> ApplyMappingAsync(string? mappingRef, JsonNode? currentMessage, string? currentType, ExecutionState state, bool useGivenInput = false)
    {
        if (string.IsNullOrWhiteSpace(mappingRef))
        {
            throw new InvalidOperationException("transform step is missing mappingRef.");
        }

        if (!_mappings.TryGetValue(mappingRef, out var mapping))
        {
            throw new InvalidOperationException($"mapping '{mappingRef}' not found.");
        }

        var expression = !string.IsNullOrWhiteSpace(mapping.Expression)
            ? mapping.Expression!
            : JsonataRuleSynthesizer.Synthesize(mapping.Rules ?? []);

        var sourceType = mapping.Source?.MessageRef;
        var message = currentMessage;
        if (!useGivenInput
            && !string.IsNullOrWhiteSpace(sourceType)
            && currentType is not null
            && !string.Equals(currentType, sourceType, StringComparison.Ordinal)
            && state.Context[ContextKey(sourceType!)] is JsonNode prior)
        {
            message = prior.DeepClone();
        }

        var input = string.Equals(mapping.Source?.ContentPath, "body", StringComparison.Ordinal)
            ? BuildEnvelope(message, state)
            : message;

        var output = await _jsonataEvaluator.EvaluateAsync(expression, input, state.Context);
        var targetType = mapping.Target?.MessageRef;
        RecordHistory(targetType, output, state);
        return new StepOutcome(output, targetType);
    }

    private async Task<bool> EvaluateBooleanAsync(ExpressionDefinition? expression, JsonNode? currentMessage, ExecutionState state)
    {
        if (expression is null || string.IsNullOrWhiteSpace(expression.Expression))
        {
            return false;
        }

        var value = await _jsonataEvaluator.EvaluateAsync(expression.Expression!, BuildEnvelope(currentMessage, state), state.Context);
        return value switch
        {
            JsonValue jsonValue when jsonValue.TryGetValue<bool>(out var booleanValue) => booleanValue,
            JsonValue jsonValue when jsonValue.TryGetValue<string>(out var stringValue) && bool.TryParse(stringValue, out var parsed) => parsed,
            _ => false,
        };
    }

    private static JsonObject BuildEnvelope(JsonNode? body, ExecutionState state)
    {
        var headers = new JsonObject();
        foreach (var header in state.RequestHeaders)
        {
            headers[header.Key] = header.Value;
        }

        return new JsonObject
        {
            ["body"] = body?.DeepClone(),
            ["headers"] = headers,
            ["context"] = state.Context.DeepClone(),
        };
    }

    private string? ResolveChannelMessage(string? channelName) =>
        !string.IsNullOrWhiteSpace(channelName) && _channels.TryGetValue(channelName!, out var channel)
            ? channel.SchemaRef
            : null;

    private static void RecordHistory(string? messageType, JsonNode? message, ExecutionState state)
    {
        if (!string.IsNullOrWhiteSpace(messageType))
        {
            state.Context[ContextKey(messageType!)] = message?.DeepClone();
        }
    }

    // PaymentRequest -> paymentRequest, GatewayCallback-Received -> gatewayCallbackReceived.
    internal static string ContextKey(string messageType)
    {
        var parts = System.Text.RegularExpressions.Regex.Split(messageType, "[^A-Za-z0-9]+")
            .Where(part => part.Length > 0)
            .ToArray();
        if (parts.Length == 0)
        {
            return messageType;
        }

        var key = new StringBuilder(char.ToLowerInvariant(parts[0][0]) + parts[0][1..]);
        foreach (var part in parts.Skip(1))
        {
            key.Append(char.ToUpperInvariant(part[0])).Append(part[1..]);
        }

        return key.ToString();
    }

    private static JsonNode? ResolveInvokeResponse(StepDefinition step, JsonObject context)
    {
        if (string.IsNullOrWhiteSpace(step.Dependency) || string.IsNullOrWhiteSpace(step.OperationId))
        {
            return new JsonObject();
        }

        if (context[step.Dependency!] is not JsonObject dependencyObject)
        {
            return new JsonObject();
        }

        return dependencyObject[step.OperationId!]?.DeepClone() ?? new JsonObject();
    }

    private EmittedMessage CreateEmittedMessage(string? channelName, JsonNode? body, ExecutionState state)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(channelName)
            && _channels.TryGetValue(channelName!, out var channel)
            && !string.IsNullOrWhiteSpace(channel.SchemaRef)
            && _messages.TryGetValue(channel.SchemaRef!, out var message)
            && message.Headers is not null)
        {
            foreach (var header in message.Headers)
            {
                var value = HeaderResolver.Resolve(header, body, state.Context, state.RequestHeaders);
                if (value is not null)
                {
                    headers[header.Name!] = value;
                }
            }
        }

        return new EmittedMessage(channelName ?? string.Empty, body?.DeepClone(), headers);
    }

    private string ResolveRelativePath(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
        {
            throw new InvalidOperationException("fixture path is missing.");
        }

        return Path.GetFullPath(Path.Combine(_integrationFolder, relativePath!));
    }

    private static async Task<JsonNode?> LoadJsonAsync(string path)
    {
        var json = await File.ReadAllTextAsync(path);
        return JsonNode.Parse(json);
    }

    private static FlowTestResult Pass(string flowName, string testName) =>
        new()
        {
            Flow = flowName,
            Test = testName,
            Result = "PASS",
            Detail = null,
        };

    private static FlowTestResult Fail(string flowName, string testName, string detail) =>
        new()
        {
            Flow = flowName,
            Test = testName,
            Result = "FAIL",
            Detail = detail,
        };
}

internal static class HeaderResolver
{
    public static string? Resolve(MessageHeaderDefinition header, JsonNode? body, JsonObject context, IReadOnlyDictionary<string, string> requestHeaders)
    {
        if (string.IsNullOrWhiteSpace(header.Source))
        {
            return null;
        }

        return header.Source switch
        {
            "literal" => header.Value,
            "requestHeader" => ResolveRequestHeader(header, requestHeaders),
            "context" => ResolvePath(context, header.Value),
            "body" => ResolvePath(body, header.Value),
            "generated" => Guid.NewGuid().ToString(),
            _ => null,
        };
    }

    private static string? ResolveRequestHeader(MessageHeaderDefinition header, IReadOnlyDictionary<string, string> requestHeaders)
    {
        var key = header.Value ?? header.Name;
        if (key is null)
        {
            return null;
        }

        return requestHeaders.TryGetValue(key, out var value) ? value : null;
    }

    private static string? ResolvePath(JsonNode? node, string? path)
    {
        if (node is null || string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        var normalized = path!.StartsWith("body.", StringComparison.Ordinal) ? path[5..] : path;
        JsonNode? current = node;
        foreach (var segment in normalized.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            current = current?[segment];
        }

        return current switch
        {
            JsonValue value => value.ToJsonString().Trim('"'),
            _ => current?.ToJsonString(),
        };
    }
}

internal static class JsonNodeFactory
{
    // Flow-test context values may be nested (the IR schema allows any JSON value),
    // e.g. `<Dependency>: { <operationId>: <mock response> }` read by invoke steps.
    public static JsonObject ObjectFromDictionary(Dictionary<string, object?>? values)
    {
        var result = new JsonObject();
        if (values is null)
        {
            return result;
        }

        foreach (var pair in values)
        {
            result[pair.Key] = FromYaml(pair.Value);
        }

        return result;
    }

    private static JsonNode? FromYaml(object? value) => value switch
    {
        null => null,
        string text => JsonValue.Create(text),
        IDictionary<object, object?> map => ObjectFromMap(map),
        IEnumerable<object?> items => new JsonArray(items.Select(FromYaml).ToArray()),
        _ => JsonSerializer.SerializeToNode(value),
    };

    private static JsonObject ObjectFromMap(IDictionary<object, object?> map)
    {
        var result = new JsonObject();
        foreach (var pair in map)
        {
            result[Convert.ToString(pair.Key, System.Globalization.CultureInfo.InvariantCulture)!] = FromYaml(pair.Value);
        }

        return result;
    }
}

internal static class JsonataRuleSynthesizer
{
    public static string Synthesize(IReadOnlyList<MappingRuleDefinition> rules)
    {
        var root = new JsonataObjectNode();
        foreach (var rule in rules)
        {
            if (string.IsNullOrWhiteSpace(rule.Target))
            {
                continue;
            }

            var expression = ResolveExpression(rule);
            root.Assign(rule.Target!, expression);
        }

        return root.ToExpression();
    }

    private static string ResolveExpression(MappingRuleDefinition rule)
    {
        if (!string.IsNullOrWhiteSpace(rule.Expression))
        {
            return rule.Expression!;
        }

        if (!string.IsNullOrWhiteSpace(rule.Source))
        {
            return rule.Source!;
        }

        if (rule.Default is not null)
        {
            return JsonSerializer.Serialize(rule.Default);
        }

        return "null";
    }

    private sealed class JsonataObjectNode
    {
        private readonly Dictionary<string, JsonataObjectNode> _children = new(StringComparer.Ordinal);
        private string? _expression;

        public void Assign(string target, string expression)
        {
            var segments = target.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            Assign(segments, 0, expression);
        }

        private void Assign(string[] segments, int index, string expression)
        {
            if (index == segments.Length - 1)
            {
                if (!_children.TryGetValue(segments[index], out var node))
                {
                    node = new JsonataObjectNode();
                    _children[segments[index]] = node;
                }

                node._expression = expression;
                return;
            }

            if (!_children.TryGetValue(segments[index], out var child))
            {
                child = new JsonataObjectNode();
                _children[segments[index]] = child;
            }

            child.Assign(segments, index + 1, expression);
        }

        public string ToExpression()
        {
            if (_children.Count == 0)
            {
                return _expression ?? "null";
            }

            var properties = _children.Select(pair => $"{JsonSerializer.Serialize(pair.Key)}: {pair.Value.ToExpression()}");
            return "{" + string.Join(", ", properties) + "}";
        }
    }
}

internal sealed class JsonataEvaluator
{
    public async Task<JsonNode?> EvaluateAsync(string expression, JsonNode? input, JsonObject context)
    {
        var expressionFile = Path.GetTempFileName();
        var inputFile = Path.GetTempFileName();
        var contextFile = Path.GetTempFileName();

        try
        {
            await File.WriteAllTextAsync(expressionFile, expression);
            await File.WriteAllTextAsync(inputFile, input?.ToJsonString() ?? "null");
            await File.WriteAllTextAsync(contextFile, context.ToJsonString());

            var script = "const fs=require('fs'); const jsonata=require('jsonata'); const [exprPath,inputPath,contextPath]=process.argv.slice(1); const expression=fs.readFileSync(exprPath,'utf8'); const input=JSON.parse(fs.readFileSync(inputPath,'utf8')); const context=JSON.parse(fs.readFileSync(contextPath,'utf8')); Promise.resolve(jsonata(expression).evaluate(input,{context})).then(result=>{ process.stdout.write(JSON.stringify(result === undefined ? null : result)); }).catch(error=>{ console.error(error.message || String(error)); process.exit(1); });";
            var startInfo = new ProcessStartInfo
            {
                FileName = "node",
                ArgumentList = { "-e", script, expressionFile, inputFile, contextFile },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            NodeEnvironment.Apply(startInfo);

            using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("failed to start node process.");
            var stdout = await process.StandardOutput.ReadToEndAsync();
            var stderr = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? "jsonata evaluation failed." : stderr.Trim());
            }

            return string.IsNullOrWhiteSpace(stdout) ? null : JsonNode.Parse(stdout);
        }
        finally
        {
            SafeDelete(expressionFile);
            SafeDelete(inputFile);
            SafeDelete(contextFile);
        }
    }

    private static void SafeDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
        }
    }
}

internal static class JsonDiff
{
    public static string Describe(JsonNode? expected, JsonNode? actual, string label)
    {
        return TryFindDifference(expected, actual, "$", out var detail)
            ? $"{label} mismatch: {detail}"
            : $"{label} mismatch.";
    }

    private static bool TryFindDifference(JsonNode? expected, JsonNode? actual, string path, out string detail)
    {
        if (expected is null && actual is null)
        {
            detail = string.Empty;
            return false;
        }

        if (expected is null || actual is null)
        {
            detail = $"at {path}: expected {Serialize(expected)}, actual {Serialize(actual)}";
            return true;
        }

        if (expected.GetType() != actual.GetType())
        {
            detail = $"at {path}: expected {Serialize(expected)}, actual {Serialize(actual)}";
            return true;
        }

        if (expected is JsonObject expectedObject && actual is JsonObject actualObject)
        {
            foreach (var property in expectedObject)
            {
                if (!actualObject.ContainsKey(property.Key))
                {
                    detail = $"at {path}.{property.Key}: expected property was missing";
                    return true;
                }

                if (TryFindDifference(property.Value, actualObject[property.Key], $"{path}.{property.Key}", out detail))
                {
                    return true;
                }
            }

            foreach (var property in actualObject)
            {
                if (!expectedObject.ContainsKey(property.Key))
                {
                    detail = $"at {path}.{property.Key}: unexpected property {Serialize(property.Value)}";
                    return true;
                }
            }

            detail = string.Empty;
            return false;
        }

        if (expected is JsonArray expectedArray && actual is JsonArray actualArray)
        {
            if (expectedArray.Count != actualArray.Count)
            {
                detail = $"at {path}: expected array length {expectedArray.Count}, actual {actualArray.Count}";
                return true;
            }

            for (var index = 0; index < expectedArray.Count; index++)
            {
                if (TryFindDifference(expectedArray[index], actualArray[index], $"{path}[{index}]", out detail))
                {
                    return true;
                }
            }

            detail = string.Empty;
            return false;
        }

        if (!JsonNode.DeepEquals(expected, actual))
        {
            detail = $"at {path}: expected {Serialize(expected)}, actual {Serialize(actual)}";
            return true;
        }

        detail = string.Empty;
        return false;
    }

    private static string Serialize(JsonNode? node) => node?.ToJsonString() ?? "null";
}

internal static class MarkdownReportWriter
{
    public static string Write(FlowTestReport report)
    {
        var builder = new StringBuilder();
        builder.AppendLine("# Flow Test Report");
        builder.AppendLine();
        builder.AppendLine($"Generated: {report.Generated}");
        builder.AppendLine();
        builder.AppendLine("## Summary");
        builder.AppendLine($"- Passed: {report.Summary.Passed}");
        builder.AppendLine($"- Failed: {report.Summary.Failed}");
        builder.AppendLine($"- Skipped: {report.Summary.Skipped}");
        builder.AppendLine($"Verdict: {report.Summary.Verdict}");
        builder.AppendLine();
        builder.AppendLine("## Results");
        builder.AppendLine();
        builder.AppendLine("| Flow | Test | Result | Detail |");
        builder.AppendLine("|------|------|--------|--------|");

        foreach (var result in report.Results)
        {
            builder.AppendLine($"| {EscapeCell(result.Flow)} | {EscapeCell(result.Test)} | {EscapeCell(result.Result)} | {EscapeCell(result.Detail ?? string.Empty)} |");
        }

        return builder.ToString();
    }

    private static string EscapeCell(string value) => value.Replace("|", "\\|");
}

// Node's require() does not search the global npm folder, so a jsonata
// installed with `npm install -g jsonata` is invisible to child node
// processes. Append `npm root -g` to NODE_PATH; a local node_modules still
// wins because require() checks it before NODE_PATH.
internal static class NodeEnvironment
{
    private static readonly Lazy<string?> GlobalRoot = new(ResolveGlobalRoot);

    public static void Apply(ProcessStartInfo startInfo)
    {
        var globalRoot = GlobalRoot.Value;
        if (string.IsNullOrEmpty(globalRoot))
        {
            return;
        }

        var existing = Environment.GetEnvironmentVariable("NODE_PATH");
        startInfo.Environment["NODE_PATH"] = string.IsNullOrEmpty(existing)
            ? globalRoot
            : existing + Path.PathSeparator + globalRoot;
    }

    private static string? ResolveGlobalRoot()
    {
        try
        {
            // npm is a .cmd shim on Windows, which Process.Start cannot launch directly.
            var startInfo = OperatingSystem.IsWindows()
                ? new ProcessStartInfo("cmd.exe") { ArgumentList = { "/c", "npm", "root", "-g" } }
                : new ProcessStartInfo("npm") { ArgumentList = { "root", "-g" } };
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;

            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return null;
            }

            var output = process.StandardOutput.ReadToEnd().Trim();
            process.WaitForExit(10_000);
            return process.ExitCode == 0 && Directory.Exists(output) ? output : null;
        }
        catch
        {
            return null;
        }
    }
}

internal sealed class RuntimePrerequisite
{
    public bool Success { get; private init; }

    public static async Task<RuntimePrerequisite> CheckAsync()
    {
        var versionCheck = await RunProcessAsync("node", "--version");
        if (!versionCheck.Success)
        {
            return new RuntimePrerequisite { Success = false };
        }

        var jsonataCheck = await RunProcessAsync("node", "-e \"require('jsonata')\"");
        return new RuntimePrerequisite { Success = jsonataCheck.Success };
    }

    private static async Task<(bool Success, string Output)> RunProcessAsync(string fileName, string arguments)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            if (fileName == "node")
            {
                NodeEnvironment.Apply(startInfo);
            }

            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return (false, string.Empty);
            }

            var stdout = await process.StandardOutput.ReadToEndAsync();
            var stderr = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            return (process.ExitCode == 0, string.Concat(stdout, stderr));
        }
        catch
        {
            return (false, string.Empty);
        }
    }
}

internal sealed record EmittedMessage(string Channel, JsonNode? Body, Dictionary<string, string> Headers);

internal sealed class ExecutionState
{
    public ExecutionState(JsonObject context, IReadOnlyDictionary<string, string> requestHeaders, IReadOnlyList<TestFaultDefinition> faults, ErrorHandlingDefinition? documentErrorHandling, ErrorHandlingDefinition? flowErrorHandling)
    {
        Context = context;
        RequestHeaders = requestHeaders;
        Faults = faults;
        DocumentErrorHandling = documentErrorHandling;
        FlowErrorHandling = flowErrorHandling;
    }

    public JsonObject Context { get; }
    public IReadOnlyDictionary<string, string> RequestHeaders { get; }
    public IReadOnlyList<TestFaultDefinition> Faults { get; }
    public ErrorHandlingDefinition? DocumentErrorHandling { get; }
    public ErrorHandlingDefinition? FlowErrorHandling { get; }
    public List<EmittedMessage> EmittedMessages { get; } = [];
    public HashSet<string> ReachedSteps { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, int> StepAttempts { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, int> FaultAttempts { get; } = new(StringComparer.Ordinal);
    public string? LastError { get; set; }
    public JsonNode? TriggerMessage { get; set; }
    public string? TriggerType { get; set; }
    public HashSet<string> PinnedContextKeys { get; } = new(StringComparer.Ordinal);
}

internal sealed class UnhandledStepException(string stepId, Exception inner)
    : Exception($"step '{stepId}' failed: {inner.Message}", inner)
{
    public string StepId { get; } = stepId;
}

internal sealed class FaultInjectedException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

internal sealed class FlowTestReport
{
    public string Generated { get; set; } = string.Empty;
    public FlowTestSummary Summary { get; set; } = new();
    public List<FlowTestResult> Results { get; set; } = [];
}

internal sealed class FlowTestSummary
{
    public int Passed { get; set; }
    public int Failed { get; set; }
    public int Skipped { get; set; }
    public string Verdict { get; set; } = "PASS";
}

internal sealed class FlowTestResult
{
    public string Flow { get; set; } = string.Empty;
    public string Test { get; set; } = string.Empty;
    public string Result { get; set; } = string.Empty;
    public string? Detail { get; set; }
}

internal sealed class IntegrationDocument
{
    public List<ChannelDefinition>? Channels { get; set; }
    public List<MessageDefinition>? Messages { get; set; }
    public List<MappingDefinition>? Mappings { get; set; }
    public List<FlowDefinition>? Flows { get; set; }
    public ErrorHandlingDefinition? ErrorHandling { get; set; }
}

internal sealed class ChannelDefinition
{
    public string? Name { get; set; }
    public string? SchemaRef { get; set; }
}

internal sealed class MessageDefinition
{
    public string? Name { get; set; }
    public List<MessageHeaderDefinition>? Headers { get; set; }
}

internal sealed class MessageHeaderDefinition
{
    public string? Name { get; set; }
    public string? Source { get; set; }
    public string? Value { get; set; }
}

internal sealed class MappingDefinition
{
    public string? Name { get; set; }
    public string? Engine { get; set; }
    public string? Expression { get; set; }
    public List<MappingRuleDefinition>? Rules { get; set; }
    public MappingEndDefinition? Source { get; set; }
    public MappingEndDefinition? Target { get; set; }
}

internal sealed class MappingEndDefinition
{
    public string? MessageRef { get; set; }
    public string? ContentPath { get; set; }
}

internal sealed class MappingRuleDefinition
{
    public string? Target { get; set; }
    public string? Source { get; set; }
    public string? Expression { get; set; }
    public object? Default { get; set; }
}

internal sealed class FlowDefinition
{
    public string Name { get; set; } = string.Empty;
    public List<StepDefinition>? Steps { get; set; }
    public List<FlowDefinitionTest>? Tests { get; set; }
    public ErrorHandlingDefinition? ErrorHandling { get; set; }
}

internal sealed class StepDefinition
{
    public string? Id { get; set; }
    public string? Type { get; set; }
    public string? Next { get; set; }
    public string? MappingRef { get; set; }
    public string? Channel { get; set; }
    public ExpressionDefinition? Predicate { get; set; }
    public List<RouteDefinition>? Routes { get; set; }
    public List<string>? Targets { get; set; }
    public string? Dependency { get; set; }
    public string? OperationId { get; set; }
    public string? Store { get; set; }
    public string? Target { get; set; }
    public string? ResultKey { get; set; }
    public RetryDefinition? Retry { get; set; }
    public ErrorHandlingDefinition? ErrorHandling { get; set; }
}

internal sealed class RouteDefinition
{
    public ExpressionDefinition? When { get; set; }
    public bool? Default { get; set; }
    public string? Next { get; set; }
}

internal sealed class ExpressionDefinition
{
    public string? Engine { get; set; }
    public string? Expression { get; set; }
}

internal sealed class FlowDefinitionTest
{
    public string Name { get; set; } = string.Empty;
    public TriggerDefinition? Trigger { get; set; }
    public Dictionary<string, object?>? Context { get; set; }
    public List<ExpectationDefinition>? Expect { get; set; }
    public List<TestFaultDefinition>? Faults { get; set; }
}

internal sealed class TriggerDefinition
{
    public string? Channel { get; set; }
    public string? Path { get; set; }
    public Dictionary<string, string>? Headers { get; set; }
}

internal sealed class ExpectationDefinition
{
    public string? Channel { get; set; }
    public BodyFixtureDefinition? Body { get; set; }
    public Dictionary<string, string>? Headers { get; set; }
    public string? Step { get; set; }
    public ErrorExpectationDefinition? Error { get; set; }
}

internal sealed class BodyFixtureDefinition
{
    public string? Path { get; set; }
}

internal sealed class ErrorExpectationDefinition
{
    public int? AfterRetries { get; set; }
    public string? DlqChannel { get; set; }
}

internal sealed class TestFaultDefinition
{
    public string? Step { get; set; }
    public string? Error { get; set; }
    public string? ErrorCode { get; set; }
    public int AfterAttempts { get; set; }
}

internal sealed class ErrorHandlingDefinition
{
    public RetryDefinition? Retry { get; set; }
    public DlqDefinition? Dlq { get; set; }
    public string? Fallback { get; set; }
    public string? OnError { get; set; }
    public List<string>? NonRetryableErrors { get; set; }
    public string? AttemptMappingRef { get; set; }
}

internal sealed class RetryDefinition
{
    public string? Policy { get; set; }
    public int? Count { get; set; }
    public string? Interval { get; set; }
}

internal sealed class DlqDefinition
{
    public string? Channel { get; set; }
    public string? MappingRef { get; set; }
}