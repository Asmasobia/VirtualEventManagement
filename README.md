# VirtualEventManagement# Virtual Event Management Platform

A backend REST API for managing virtual events, built with Node.js and Express.

## 🚀 Features

- User authentication and authorization (JWT-based)
- Event creation and management
- Secure password hashing with bcrypt
- Email notifications via Nodemailer
- UUID-based unique identifiers
- Environment-based configuration

## 🛠️ Tech Stack

- **Runtime:** Node.js
- **Framework:** Express v5
- **Authentication:** JSON Web Tokens (jsonwebtoken)
- **Password Hashing:** bcryptjs
- **Email Service:** Nodemailer
- **Environment Variables:** dotenv
- **Unique IDs:** uuid
- **Dev Tool:** Nodemon

## 📌 API Endpoints

### 🔐 Authentication
| Method | Route       | Description                        | Auth Required | Role     |
|--------|-------------|------------------------------------|---------------|----------|
| POST   | `/register` | Register a new user                | ❌ No         | Any      |
| POST   | `/login`    | Login and receive JWT token        | ❌ No         | Any      |
| GET    | `/profile`  | Get current authenticated user     | ✅ Yes        | Any      |

### 📅 Event Management
| Method | Route        | Description                        | Auth Required | Role      |
|--------|--------------|------------------------------------|---------------|-----------|
| GET    | `/events`    | Get all events (supports filters)  | ❌ No         | Any       |
| POST   | `/events`    | Create a new event                 | ✅ Yes        | Organizer |
| GET    | `/events/:id`| Get a single event by ID           | ❌ No         | Any       |
| PUT    | `/events/:id`| Update an existing event           | ✅ Yes        | Organizer |
| DELETE | `/events/:id`| Delete an event                    | ✅ Yes        | Organizer |

### 👥 Participant Management
| Method | Route                      | Description                        | Auth Required | Role      |
|--------|----------------------------|------------------------------------|---------------|-----------|
| POST   | `/events/:id/register`     | Register for an event              | ✅ Yes        | Attendee  |
| DELETE | `/events/:id/register`     | Unregister from an event           | ✅ Yes        | Attendee  |
| GET    | `/events/:id/participants` | View all participants of an event  | ✅ Yes        | Organizer |

### 🔍 Query Parameters (GET /events)
| Parameter     | Type    | Description                          | Example                  |
|---------------|---------|--------------------------------------|--------------------------|
| `upcoming`    | Boolean | Filter only future events            | `?upcoming=true`         |
| `organizerId` | String  | Filter events by organizer           | `?organizerId=uuid-here` |
| `search`      | String  | Search in title or description       | `?search=webinar`        |