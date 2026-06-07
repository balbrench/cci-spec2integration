# Template Authoring

When editing or creating files under `templates/`:

1. Templates are skeletons filled in by agents — they contain placeholder markers like `<PLACEHOLDER>` or `{{variable}}` that agents replace.
2. Core templates (`templates/core/`) must remain platform-neutral. No Azure, AWS, or vendor-specific references.
3. Azure templates (`templates/azure/`) may reference Azure-specific constructs (Logic Apps, Bicep, Service Bus).
4. BizTalk templates (`templates/biztalk/`) are used during reverse-engineering of BizTalk solutions.
5. Platform-pack templates (`templates/platform-pack/`) define the extension point contract for new platform packs.
6. Do not add implementation logic to templates — they are structural scaffolds only.
