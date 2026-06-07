# Specify the BizTalk source

A **BizTalk migration** starts from your existing solution. Click **Specify
BizTalk Source Folder** and point the extension at it — it can live anywhere on
disk:

- a BizTalk application **MSI** (BTSTask `ExportApp` output), or
- the exploded solution — orchestrations (`.odx`), maps (`.btm`), schemas
  (`.xsd`), pipelines, binding files, and BRE policies.

The folder you pick is **remembered** for the rest of the migration (and the
picker defaults to it, the path recorded in an existing inventory, or a `source/`
folder that actually holds a `.btproj`). If the folder has no `.btproj`, the
extension warns you before continuing.

Once the source is set, the welcome button becomes **Analyse Solution**.
