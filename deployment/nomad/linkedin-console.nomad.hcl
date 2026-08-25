job "linkedin-hyper-v" {
  datacenters = ["dc1"]
  type        = "service"

  variable "environment" {
    type        = string
    description = "Deployment target environment (staging, production)"
    default     = "production"
  }

  variable "worker_count" {
    type        = number
    description = "Number of worker engine instances to scale"
    default     = 3
  }

  variable "app_count" {
    type        = number
    description = "Number of Next.js dashboard instances"
    default     = 2
  }

  variable "image_tag" {
    type        = string
    description = "Docker image tag / commit hash to deploy"
    default     = "latest"
  }

  group "web-app" {
    count = var.app_count

    network {
      port "http" {
        to = 3000
      }
    }

    service {
      name = "linkedin-hyper-v-app"
      port = "http"

      check {
        type     = "http"
        path     = "/api/health"
        interval = "10s"
        timeout  = "2s"
      }
    }

    task "app-service" {
      driver = "docker"

      config {
        image = "registry.internal.net/linkedin-app:${var.image_tag}"
        ports = ["http"]
      }

      template {
        data = <<EOH
NODE_ENV="{{ keyOrDefault "linkedin-hyper-v/${var.environment}/node_env" "production" }}"
DATABASE_URL="{{ key "linkedin-hyper-v/${var.environment}/database_url" }}"
NEXT_PUBLIC_APP_ENV="{{ var.environment }}"
EOH
        destination = "secrets/app.env"
        env         = true
      }

      resources {
        cpu    = 500
        memory = 512
      }
    }
  }

  group "worker-engine" {
    count = var.worker_count

    network {
      port "health" {
        to = 8080
      }
    }

    service {
      name = "linkedin-hyper-v-worker"
      port = "health"

      check {
        type     = "http"
        path     = "/healthz"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "worker-service" {
      driver = "docker"

      config {
        image = "registry.internal.net/linkedin-worker:${var.image_tag}"
        ports = ["health"]
      }

      template {
        data = <<EOH
NODE_ENV="production"
DATABASE_URL="{{ key "linkedin-hyper-v/${var.environment}/database_url" }}"
REDIS_URL="{{ key "linkedin-hyper-v/${var.environment}/redis_url" }}"
LOG_LEVEL="{{ keyOrDefault "linkedin-hyper-v/${var.environment}/log_level" "info" }}"
HEALTH_PORT="8080"
EOH
        destination = "secrets/worker.env"
        env         = true
      }

      resources {
        cpu    = 1000
        memory = 1024
      }
    }
  }
}
