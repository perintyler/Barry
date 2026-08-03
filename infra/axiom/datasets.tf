import {
  to = axiom_dataset.barry
  id = "barry"
}

resource "axiom_dataset" "barry" {
  name        = "barry"
  description = "Barry service logs"
}

resource "axiom_dataset" "barry_network" {
  name        = "barry_network"
  description = "Barry network and firewall logs"
}
