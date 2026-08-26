// Canonical AppError lives with the domain modules so application services can
// raise typed failures without importing the app. Re-exported here for filters
// and pipes.
export { AppError, type FieldError } from '@gogo/modules';
