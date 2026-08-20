export function greet(name: string): string {
    if (name.trim() === "") {
        return "Hello!";
    }
    return `Hello, ${name}.`;
}

