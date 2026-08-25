export class UserDirectory {
    #users = [];

    register({ name, email }) {
        const normalizedName = name.trim();
        const storedEmail = email.trim();
        if (normalizedName === "") {
            throw new Error("Name is required");
        }
        if (!storedEmail.includes("@")) {
            throw new Error("Email is invalid");
        }
        if (this.#users.some((user) => user.email === storedEmail)) {
            throw new Error("Email is already registered");
        }
        const user = {
            id: this.#users.length + 1,
            name: normalizedName,
            email: storedEmail,
        };
        this.#users.push(user);
        return { ...user };
    }

    list() {
        return this.#users.map((user) => ({ ...user }));
    }
}
