# Deployment targets

One YAML file per deployment, included by `databricks.yml` (`targets/*.yml`). A target says where one utility's
deployment lives: the workspace, the schema holding its asset data model, the output schema, the SQL warehouse and
the app's name. That is deployment configuration, not product, so git ignores `targets/*.yml`: keep your targets in
your own (private) configuration store.

Start from `example.yml.template`: copy it to `targets/<name>.yml`, fill in the values, and deploy with
`scripts/bundle.sh deploy -t <name> --profile <profile>`.
