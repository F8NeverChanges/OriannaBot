import * as eris from "eris"
import debug = require("debug");
import config from "../config";
import randomstring = require("randomstring");
import { Command, ResponseContext } from "./command";
import Response, { ResponseOptions } from "./response";
import { Server, User, BlacklistedChannel, UserAuthKey } from "../database";
import Updater from "./updater";
import RiotAPI from "../riot/api";
import PuppeteerController from "../puppeteer";
import { randomBytes } from "crypto";
import elastic from "../elastic";
import { Commit, getLastCommit } from "git-last-commit";

const info = debug("orianna:discord");
const error = debug("orianna:discord:error");

const HELP_REACTION = "❓";
const HELP_INDEX_REACTION = "🔖";
const MUTE_REACTION = "🔇";

const LOL_APPLICATION_ID = "401518684763586560";

const STATUSES: [number, string][] = [
    [0, "on-hit Orianna"],
    [0, "with the Ball"],
    [2, "time ticking away"],
    [3, "my enemies shiver"],
    [3, "you"],
    [3, "Piltovan theater"],
    [2, "Running in the 90s"],
    [0, "with Stopwatch"],
    [3, "imaqtpie"],
    [2, "them scream"],
    [3, "what makes them tick"],
    [0, "Command: Attack"],
    [0, "Command: Dissonance"],
    [0, "Command: Protect"],
    [0, "Command: Shockwave"]
];

export default class DiscordClient {
    public readonly bot = new eris.Client(config.discord.token, { maxShards: "auto" });
    public readonly updater = new Updater(this, this.riotAPI);
    public readonly commands: Command[] = [];
    private responses: Response[] = [];
    private statusIndex = 0;
    private presenceTimeouts = new Map<string, number>();

    constructor(public readonly riotAPI: RiotAPI, public readonly puppeteer: PuppeteerController) {}

    /**
     * Adds a new command to this DiscordClient instance.
     */
    registerCommand(cmd: Command) {
        this.commands.push(cmd);
    }

    /**
     * Initially connects to discord and attaches listeners.
     */
    async connect() {
        await this.bot.connect();

        this.bot.on("ready", () => {
            info("Connected to discord as %s (%s)", this.bot.user.username, this.bot.user.id);
        });

        this.bot.on("messageCreate", this.handleMessage);
        this.bot.on("messageUpdate", this.handleEdit);
        this.bot.on("messageReactionAdd", this.handleReaction);
        this.bot.on("messageDelete", this.handleDelete);
        this.bot.on("guildUpdate", this.handleGuildUpdate);
        this.bot.on("userUpdate", this.handleUserUpdate);
        this.bot.on("guildMemberAdd", this.handleGuildMemberAdd);
        this.bot.on("presenceUpdate", this.handlePresenceUpdate);

        const commit = await new Promise<Commit>((res, rej) => getLastCommit((e, r) => e ? rej(e) : res(r)));
        const formatStatus = (stat: string) => {
            const suffix = `Version ${commit.shortHash} - ${commit.subject}`;
            return stat + " \n" + Array(126 - stat.length - suffix.length).join("\u3000") + suffix;
        };

        // Cycle game playing statuses.
        setInterval(() => {
            this.statusIndex = (this.statusIndex + 1) % STATUSES.length;

            this.bot.editStatus("online", {
                type: STATUSES[this.statusIndex][0],
                name: formatStatus(STATUSES[this.statusIndex][1])
            });
        }, 10 * 60 * 1000); // cycle every 10 mins

        this.bot.editStatus("online", {
            name: formatStatus(STATUSES[0][1]),
            type: STATUSES[0][0]
        });
    }

    /**
     * Finds or creates a new Server instance for the specified Discord snowflake.
     */
    public async findOrCreateServer(id: string): Promise<Server> {
        const server = await Server.query().where("snowflake", "=", id).first();
        if (server) return server;

        const guild = this.bot.guilds.get(id);
        if (!guild) throw new Error("Not a member of server " + id);

        return Server.query().insertAndFetch({
            snowflake: guild.id,
            name: guild.name,
            avatar: guild.icon || "none",
            announcement_channel: null,
            default_champion: null,
            completed_intro: false
        });
    }

    /**
     * Finds or creates a new User instance for the specified Discord snowflake.
     */
    public async findOrCreateUser(id: string, discordUser?: { username: string, avatar?: string }): Promise<User> {
        let user = await User.query().where("snowflake", "=", id).first();
        if (user) return user;

        discordUser = discordUser || this.bot.users.get(id);
        if (!discordUser) throw new Error("No common server shared with server " + id);

        user = await User.query().insertAndFetch({
            snowflake: id,
            username: discordUser.username,
            avatar: discordUser.avatar || "none",
            token: randomstring.generate({
                length: 16,
                readable: true
            })
        });

        const key = await UserAuthKey.query().insertAndFetch({
            user_id: user.id,
            created_at: "2100-01-01 10:10:10", // have this one never expire, just for a bit more user friendliness
            key: randomBytes(16).toString("hex")
        });
        const link = config.web.url + "/login/" + key.key;

        // Try send them a message since this is the first time we met them.
        await this.notify(id, {
            title: "👋 Hey " + discordUser.username + "!",
            url: link,
            color: 0x49bd1a,
            description: `Since you just used a command of mine for the first time, I figured I'd introduce myself. I'm **Orianna Bot**, and I'm a pretty cool bot that keeps track of League accounts, mostly for the purpose of showing cool stats and assigning Discord roles.`
            + `\n\nIf you'd like me to track you and give you all the roles you deserve, you can add your League account using the [online configuration panel](${link}). You can also import your League accounts from Discord and the Reddit [ChampionMains Flairs](https://flairs.championmains.com) system.`
            + `\n\nTo get started, click the link below!\n${link}`
            + `\n\nConfused, intrigued, angry, happy? Check out all my available commands using \`@Orianna Bot help\` and contact my creator using \`@Orianna Bot about\`.`,
            timestamp: new Date().getTime(),
            thumbnail: "https://ddragon.leagueoflegends.com/cdn/7.7.1/img/champion/Orianna.png",
            footer: "Orianna Bot v2"
        });

        return user;
    }

    /**
     * Sends the specified message to the user with the specified ID, unless
     * we do not share a server with them (in which case we silently fail). This
     * should be used to notify users of things that don't neccessarily need interaction.
     */
    public async notify(id: string, embed: ResponseOptions) {
        try {
            if (!this.bot.users.has(id)) return;

            const user = this.bot.users.get(id)!;
            const dm = await this.bot.getDMChannel(id);
            await this.createResponse(dm, user).respond(embed);
        } catch (e) {
            // Do nothing.
        }
    }

    /**
     * Displays an interactive list of all commands in the specified channel.
     */
    public async displayHelp(channel: eris.Textable, user: eris.User, trigger: eris.Message) {
        const commands = this.commands.filter(x => !x.hideFromHelp);
        const index: ResponseOptions = {
            color: 0x0a96de,
            title: "🔖 Orianna Help",
            description: "I try to determine what you mean when you mention me using specific keywords. Here is a simple list of commands that I understand. Click the corresponding number for more information and examples about the commmand. Click 🔖 to show this index.",
            fields: commands.map((x, i) => ({ name: (i + 1) + " - " + x.name, value: x.smallDescription }))
        };

        const resp = await this.createResponse(channel, user, trigger).respond(index);
        await resp.option(HELP_INDEX_REACTION, () => resp.info(index));

        for (const cmd of commands) {
            await resp.option(decodeURIComponent((commands.indexOf(cmd) + 1) + "%E2%83%A3"), () => {
                resp.info({
                    title: "🔖 Help for " + cmd.name,
                    description: "**Description**\n" + cmd.description,
                    fields: [{
                        name: "Keywords",
                        value: cmd.keywords.map(x => "`" + x + "`").join(", ")
                    }]
                });
            });
        }

        await resp.option("🗑", () => {
            resp.remove();
        });
    }

    /**
     * Called by eris when a new message is received. Responsible for dispatching the message
     * to the user.
     */
    private handleMessage = async (msg: eris.Message, fromMute = false) => {
        const isDM = msg.channel instanceof eris.PrivateChannel;
        const hasMention = msg.mentions.map(x => x.id).includes(this.bot.user.id);

        // Don't respond to ourselves.
        if (msg.author.id === this.bot.user.id) return;

        // Clean content.
        const content = msg.content
            .replace(new RegExp(`<@!?${this.bot.user.id}>`, "g"), "")
            .replace(/\s+/g, " ").trim();
        msg.mentions = msg.mentions.filter(x => x.id !== this.bot.user.id);

        // Treat any ID and user#1111 inside the content as mentions as well.
        content.replace(/\d{16,}/g, (match) => {
            const user = this.bot.users.get(match);
            if (user && !msg.mentions.find(x => x.id === user.id)) msg.mentions.push(user);
            return "";
        });

        // AAA#0000 mentions are a bit more effort since a command like `@Ori top Some User#1234` is ambiguous between
        // "Some User#1234", "User#1234" and even "top Some User#1234". We use a hacky solution by instead relying on finding
        // all users with the discriminator, then find the user whose name is contained inside the message, prefering longer
        // matches over shorter ones (User#1234 > er#1234)
        content.replace(/\b(.*)#(\d{4})\b/g, (_, username, discrim) => {
            const usersWithDiscrim = this.bot.users.filter(x => x.discriminator === discrim);

            const bestUser = usersWithDiscrim.reduce<eris.User | null>((prev, cur) => {
                // If the username of this user is not in the query, continue.
                if (!username.includes(cur.username)) return prev;

                // If this is the first match, just return it.
                if (!prev) return cur;

                return prev.username.length >= cur.username.length ? prev : cur;
            }, null);

            if (bestUser && !msg.mentions.find(x => x.id === bestUser.id)) msg.mentions.push(bestUser);
            return "";
        });

        const words = content.toLowerCase().split(" ");

        // Find a command that is matched.
        const matchedCommand = this.commands.find(command => {
            return command.keywords.some(x => words.includes(x));
        });

        // If we didn't find a command, add a question mark.
        // We need to readd to the messages collection so we get a full
        // Message object instead of an uncached one in the reaction handler.
        if (!matchedCommand) {
            if (isDM || hasMention) {
                await msg.addReaction(HELP_REACTION, "@me");
                msg.channel.messages.add(msg);
            }

            // Eris never deletes cached messages, even though we don't need them.
            // Remove the message immediately so we don't run out of memory eventually.
            msg.channel.messages.delete(msg.id);

            return;
        }

        // If this matched command requires a mention, but we have none, abort.
        if (!isDM && !hasMention && matchedCommand.noMention !== true) return;

        info("[%s] [%s] %s", msg.author.username, matchedCommand.name, content);
        await elastic.logCommand(matchedCommand.name, msg);

        // If this is in a server, we need to check if the channel is blacklisted.
        if (!isDM && !fromMute) {
            const server = await this.findOrCreateServer((<eris.TextChannel>msg.channel).guild.id);

            // Find the first instance where snowflake = channel_snowflake. If it exists, we abort.
            if (await server.$relatedQuery<BlacklistedChannel>("blacklisted_channels").where("snowflake", "=", msg.channel.id).first()) {
                await msg.addReaction(MUTE_REACTION, "@me");
                msg.channel.messages.add(msg);
                return;
            }
        }

        // If we are responding to a muted command, respond in the DMs. Else, respond in the same channel.
        const targetChannel = fromMute ? await this.bot.getDMChannel(msg.author.id) : msg.channel;
        const responseContext = this.createResponseContext(targetChannel, msg.author, msg);

        // Send typing during computing time, unless disabled for this specific command.
        if (!matchedCommand.noTyping) await targetChannel.sendTyping();

        // Do things a bit differently depending on if the message was sent in a server or not.
        const template = {
            ...responseContext,
            client: this,
            bot: this.bot,
            channel: msg.channel,
            msg,
            content,
            user: () => this.findOrCreateUser(msg.author.id),
            ctx: <any>null
        };

        const transaction = elastic.startCommandTransaction(matchedCommand.name);
        try {
            const obj = isDM ? {
                ...template,
                guildChannel: <any>null,
                privateChannel: <eris.PrivateChannel>msg.channel,
                guild: <any>null,
                server: () => Promise.reject("Message was not sent in a server.")
            } : {
                ...template,
                guildChannel: <eris.TextChannel>msg.channel,
                privateChannel: <any>null,
                guild: (<eris.TextChannel>msg.channel).guild,
                server: () => this.findOrCreateServer((<eris.TextChannel>msg.channel).guild.id)
            };
            obj.ctx = obj;

            await matchedCommand.handler(obj);
            if (transaction) transaction.result = 200;
        } catch (e) {
            // Send a message to the user and log the error.
            error("Error during execution of '%s' by '%s' in '%s': %s'", matchedCommand.name, msg.author.id, msg.channel.id, e.message);
            error(e.stack);
            error("%O", e);

            // Report to elastic, if enabled.
            const incident = await elastic.reportError(e, "command handler");
            if (transaction) transaction.result = 404;

            await template.error({
                title: "💥 Ouch!",
                description:
                    "Something went horribly wrong executing that command. Try again in a bit, or contact my creator (`@Orianna Bot about`)"
                    + (incident ? " and give him the following code: `" + incident + "`." : "."),
                image: "https://i.imgur.com/SBpi54R.png"
            });
        } finally {
            if (transaction) transaction.end();
        }
    };

    /**
     * Handles a new reaction added to a message by a user. Responsible
     * for dispatching to responses and for handling mute/help reacts.
     */
    private handleReaction = async (msg: eris.Message, emoji: eris.Emoji, userID: string) => {
        msg = await this.bot.getMessage(msg.channel.id, msg.id);
        this.responses.forEach(x => x.onReactionAdd(msg, emoji, userID));

        if ([HELP_REACTION, MUTE_REACTION].includes(emoji.name) && userID === msg.author.id) {
            const reacts = await msg.getReaction(emoji.name);
            if (!reacts.some(x => x.id === this.bot.user.id)) return;

            if (emoji.name === MUTE_REACTION) {
                try {
                    const dms = await this.bot.getDMChannel(msg.author.id);
                    await dms.createMessage("I don't have permissions to talk in <#" + msg.channel.id + ">, but I can still secretly perform your command. Here's what you requested:");

                    this.handleMessage(msg, true);
                } catch (e) {
                    // We don't have permissions to message the user. They're most likely set to private.
                }
            } else {
                this.displayHelp(msg.channel, msg.author, msg);
            }
        }
    };

    /**
     * Handles message editing. Simulates the old message getting removed, following
     * by a new message getting sent.
     */
    private handleEdit = async (msg: eris.Message, oldMsg?: any) => {
        if (!oldMsg || !msg.author) return; // message can potentially be uncached, so check for author property
        if (msg.author.id === this.bot.user.id) return;

        await this.handleDelete(msg);
        await this.handleMessage(msg);
    };

    /**
     * Handles the deletion of a message. Simply delegates it to all responses.
     */
    private handleDelete = async (msg: eris.PossiblyUncachedMessage) => {
        this.responses = this.responses.filter(x => !x.onMessageDelete(msg));
    };

    /**
     * Updates the database representation of the guild when it changes settings.
     */
    private handleGuildUpdate = async (guild: eris.Guild, old: eris.GuildOptions) => {
        await Server
            .query()
            .where("snowflake", guild.id)
            .update({
                name: guild.name,
                avatar: guild.icon || "none"
            })
        .execute();
    };

    /**
     * Updates the database representation of the user when it changes settings.
     */
    private handleUserUpdate = async (user: eris.User) => {
        await User
            .query()
            .where("snowflake", user.id)
            .update({
                username: user.username,
                avatar: user.avatar || "none"
            })
        .execute();
    };

    /**
     * Potentially queues an update for the specified user if their discord presence
     * has just gone from Rich Presence Ingame to out of game.
     */
    private handlePresenceUpdate = async (other: eris.Member | eris.Relationship, oldPresence?: eris.OldPresence) => {
        // If there was no old game, or if the old game was not League, abort.
        if (
            !oldPresence                                                        // no old presence cached
            || !oldPresence.game                                                // not playing a game
            || (<any>oldPresence.game).application_id !== LOL_APPLICATION_ID    // the old game wasn't league
            || !(<any>oldPresence.game).assets                                  // the league game didn't have assets
            || !(<any>oldPresence.game).assets.large_text                       // the league presence didn't have the name of a champion
            || !(<any>oldPresence.game).timestamps                              // the league presence didn't have timestamps
            || !(<any>oldPresence.game).timestamps.start                        // the league presence didn't have a start timestamp.
        ) return;

        // The user got out of game if:
        // - They used to have league as a presence, and don't have league now.
        // - Or: They used to have ingame with a specific champion, and are just in a lobby now.
        const newPresenceIsLeague = other.game && (<any>other.game).application_id === LOL_APPLICATION_ID;
        const noLongerIngame = newPresenceIsLeague && (<any>other.game).assets && !(<any>other.game).assets.large_text;

        // If the new presence isn't league, or if we're no longer in game, check if we should update this user.
        if (!newPresenceIsLeague || noLongerIngame) {
            // If they were in game for less than 15 minutes, it is probably a false alarm and we should ignore it.
            const timeIngame = Date.now() - (<any>oldPresence.game).timestamps.start;
            const timeInSec = timeIngame / 1000;
            if (timeInSec < 900) return;

            // If this user has no accounts, abort as well.
            const user = await User.query().where("snowflake", other.id).eager("accounts").first();
            if (!user || !user.accounts!.length) return;

            // If we've recently processed something from this user, abort.
            if (this.presenceTimeouts.has(user.snowflake) && Date.now() < this.presenceTimeouts.get(user.snowflake)!) return;

            info(
                "User %s (%s) got out of a League game according to their presence, queueing an update. They were ingame for %im%is",
                user.username,
                user.snowflake,
                Math.floor(timeInSec / 60),
                timeInSec % 60
            );

            // Ensure that we rate limit this user. Process another update in 10 minutes.
            this.presenceTimeouts.set(user.snowflake, Date.now() + 1000 * 60 * 10);

            // Artifically modify the last update timestamps of this user to ensure that they
            // get included in the next cycle.
            await user.$query().patch({
                // Set the last update timestamp to a day ago. Should be enough to guarantee inclusion.
                last_score_update_timestamp: "" + (Date.now() - 1000 * 60 * 60 * 24),
                last_rank_update_timestamp: "" + (Date.now() - 1000 * 60 * 60 * 24)
            });
        }
    };

    /**
     * Ensures that a user receives their appropriate roles when they join a server while
     * already having accounts set up.
     */
    private handleGuildMemberAdd = async (guild: eris.Guild, member: eris.Member) => {
        // Don't use findOrCreateUser since it will message the user.
        const user = await User.query().where("snowflake", "=", member.id).first();
        if (!user) return;

        // Only update, do not fetch new data for the user.
        // This should assign new roles, if appropriate.
        this.updater.updateUser(user);
    };

    /**
     * Utility method to create a new response and add it to the list of emitted responses.
     */
    private createResponse(channel: eris.Textable, user: eris.User, msg?: eris.Message) {
        const resp = new Response(this.bot, user, channel, msg);

        this.responses.push(resp);

        // Have responses expire after a set time to prevent them from
        // indefinitely taking up resources.
        setTimeout(() => {
            const idx = this.responses.indexOf(resp);

            if (idx !== -1) {
                resp.removeAllOptions();
                this.responses.splice(idx, 1);
            }

            if (msg) {
                // Remove the message from our local cache too.
                msg.channel.messages.delete(msg.id);
            }
        }, 30 * 60 * 1000); // expire after 30 mins

        return resp;
    }

    /**
     * Creates a new ResponseContext for the specified user and channel, and optionally the trigger message.
     */
    public createResponseContext(channel: eris.Textable, user: eris.User, msg?: eris.Message): ResponseContext {
        return {
            ok: embed => this.createResponse(channel, user, msg).respond({ color: 0x49bd1a, ...embed }),
            info: embed => this.createResponse(channel, user, msg).respond({ color: 0x0a96de, ...embed }),
            error: embed => this.createResponse(channel, user, msg).respond({ color: 0xfd5c5c, ...embed }),
            respond: embed => this.createResponse(channel, user, msg).respond(embed),
            listen: (timeout = 30000) => {
                return Promise.race<eris.Message, undefined>([new Promise(resolve => {
                    const fn = (msg: eris.Message) => {
                        if (msg.channel !== channel) return;
                        if (msg.author.id !== user.id) return;

                        resolve(msg);
                        this.bot.removeListener("messageCreate", fn);
                    };

                    this.bot.on("messageCreate", fn);
                }), new Promise(resolve => setTimeout(() => resolve(undefined), timeout))]);
            }
        };
    }
}