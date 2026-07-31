output "barry_dataset_name" {
  description = "Name of the Barry service logs dataset"
  value       = axiom_dataset.barry.name
}

output "barry_network_dataset_name" {
  description = "Name of the Barry network logs dataset"
  value       = axiom_dataset.barry_network.name
}

output "error_spike_monitor_id" {
  description = "ID of the error spike monitor"
  value       = axiom_monitor.error_spike.id
}

output "service_silent_monitor_id" {
  description = "ID of the service silent monitor"
  value       = axiom_monitor.service_silent.id
}
