import {
  to = axiom_monitor.error_spike
  id = "LoHgxU5lVXE61AJoEf"
}

resource "axiom_monitor" "error_spike" {
  depends_on       = [axiom_dataset.barry]
  type             = "Threshold"
  name             = "Barry Error Spike"
  description      = "Alerts when error count exceeds threshold in a 10-minute window across Barry services"
  apl_query        = "['barry'] | where level == 'error' | summarize count() by bin(_time, 1m)"
  interval_minutes = 5
  operator         = "AboveOrEqual"
  range_minutes    = 10
  threshold        = 10
  alert_on_no_data = false
  notify_by_group  = false
}

resource "axiom_monitor" "service_silent" {
  depends_on       = [axiom_dataset.barry]
  type             = "Threshold"
  name             = "Service Silent"
  description      = "Alert when core Barry services stop producing logs"
  apl_query        = "['barry'] | where service in ('barry-web', 'barry-server', 'barry-ws') | summarize count() by bin(_time, 1m)"
  interval_minutes = 5
  operator         = "Below"
  range_minutes    = 15
  threshold        = 1
  alert_on_no_data = true
  notify_by_group  = false
}
